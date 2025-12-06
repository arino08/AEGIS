/**
 * AEGIS - Intelligent API Gateway with Rate Limiting & Observability
 *
 * Main Application Entry Point
 */

import 'dotenv/config';

import { GatewayServer, createGatewayServer } from './gateway/server.js';
import { loadConfig, getConfigLoader } from './config/loader.js';
import { initializeStorage, closeStorage } from './storage/index.js';
import logger, { logLifecycle } from './utils/logger.js';
import type { AegisConfig } from './utils/types.js';

// =============================================================================
// Global State
// =============================================================================

let gatewayServer: GatewayServer | null = null;
let isShuttingDown = false;

// =============================================================================
// Application Startup
// =============================================================================

async function bootstrap(): Promise<void> {
  logLifecycle('startup', 'AEGIS Gateway starting up...');

  try {
    // Load configuration
    logLifecycle('startup', 'Loading configuration...');
    const config: AegisConfig = await loadConfig();

    logLifecycle('startup', 'Configuration loaded', {
      port: config.server.port,
      host: config.server.host,
      environment: config.server.nodeEnv,
      backendsConfigured: config.backends.length,
    });

    // Initialize storage connections (optional - can run without if not configured)
    try {
      await initializeStorage({
        postgres: config.postgres,
        redis: config.redis,
      });
      logLifecycle('startup', 'Storage connections established');
    } catch (storageError) {
      logger.warn('Could not connect to storage services - running in proxy-only mode', {
        error: storageError instanceof Error ? storageError.message : String(storageError),
      });
    }

    // Create and initialize gateway server
    gatewayServer = createGatewayServer({ config });
    await gatewayServer.initialize();

    // Enable hot reload if configured
    if (config.hotReload) {
      const configLoader = getConfigLoader();
      configLoader.startWatching();
    }

    // Start listening for requests
    await gatewayServer.start();

    logLifecycle('ready', '🛡️  AEGIS Gateway is ready to accept connections', {
      url: `http://${config.server.host}:${config.server.port}`,
      backends: config.backends.map((b) => ({
        name: b.name,
        url: b.url,
        routes: b.routes.length,
      })),
    });

    // Print startup banner
    printBanner(config);
  } catch (error) {
    logLifecycle('error', 'Failed to start AEGIS Gateway', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  logLifecycle('shutdown', `Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 30000); // 30 second timeout

  try {
    // Stop the gateway server
    if (gatewayServer !== null) {
      await gatewayServer.shutdown();
    }

    // Close storage connections
    await closeStorage();

    // Stop config watcher
    const configLoader = getConfigLoader();
    await configLoader.stopWatching();

    clearTimeout(shutdownTimeout);
    logLifecycle('shutdown', 'AEGIS Gateway shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logLifecycle('error', 'Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  void gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    promise: String(promise),
  });
});

// =============================================================================
// Startup Banner
// =============================================================================

function printBanner(config: AegisConfig): void {
  const banner = `
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     █████╗ ███████╗ ██████╗ ██╗███████╗                          ║
║    ██╔══██╗██╔════╝██╔════╝ ██║██╔════╝                          ║
║    ███████║█████╗  ██║  ███╗██║███████╗                          ║
║    ██╔══██║██╔══╝  ██║   ██║██║╚════██║                          ║
║    ██║  ██║███████╗╚██████╔╝██║███████║                          ║
║    ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝╚══════╝                          ║
║                                                                   ║
║    Intelligent API Gateway with Rate Limiting & Observability     ║
║                                                                   ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║    🌐 Gateway:  http://${config.server.host}:${String(config.server.port).padEnd(5)}                           ║
║    📊 Status:   http://${config.server.host}:${config.server.port}/_aegis/status               ║
║    🔍 Routes:   http://${config.server.host}:${config.server.port}/_aegis/routes               ║
║    💚 Health:   http://${config.server.host}:${config.server.port}/health                      ║
║                                                                   ║
║    Environment: ${config.server.nodeEnv.padEnd(12)}                                 ║
║    Backends:    ${String(config.backends.length).padEnd(12)}                                 ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
`;

  // Use console.log for the banner to ensure it's always visible
  // eslint-disable-next-line no-console
  console.log(banner);
}

// =============================================================================
// Start Application
// =============================================================================

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
