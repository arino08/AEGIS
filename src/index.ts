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

// =============================================================================
// Application Startup
// =============================================================================

import cluster from 'node:cluster';
import os from 'node:os';

async function bootstrap(): Promise<void> {
  // Load configuration first to check worker count
  const configLoader = getConfigLoader();
  const config: AegisConfig = await configLoader.load();

  // Determine number of workers
  // 0 = all cores, 1 = single process, >1 = specific count
  const desiredWorkers = config.server.workers ?? 0;
  const numCPUs = os.cpus().length;
  const numWorkers = desiredWorkers === 0 ? numCPUs : desiredWorkers;

  // Handle Master Process
  if (cluster.isPrimary && numWorkers > 1) {
    logLifecycle('startup', `AEGIS Gateway Master ${process.pid} starting up...`);
    logLifecycle('startup', `Clustering enabled: Spawning ${numWorkers} workers`);

    // Fork workers
    for (let i = 0; i < numWorkers; i++) {
      cluster.fork();
    }

    // Handle worker exit
    cluster.on('exit', (worker, code, signal) => {
      logLifecycle('warn', `Worker ${worker.process.pid} died (code: ${code}, signal: ${signal})`);

      if (!isShuttingDown) {
        logLifecycle('info', 'Starting a new worker...');
        cluster.fork();
      }
    });

    logLifecycle('ready', `Primary process ${process.pid} is running`);

    // Print banner only once from primary
    printBanner(config, numWorkers);

    return;
  }

  // Handle Worker Process (or single process mode)
  await startWorker(config);
}

async function startWorker(config: AegisConfig): Promise<void> {
  const workerType = cluster.isWorker ? `Worker ${process.pid}` : `Single Process ${process.pid}`;
  logLifecycle('startup', `${workerType} starting up...`);

  try {
    // Initialize storage connections (optional - can run without if not configured)
    try {
      await initializeStorage({
        postgres: config.postgres,
        redis: config.redis,
      });
      // Only log storage connection success if single process or first worker (to reduce noise)
      if (!cluster.isWorker || cluster.worker?.id === 1) {
        logLifecycle('startup', 'Storage connections established');
      }
    } catch (storageError) {
      logger.warn('Could not connect to storage services - running in proxy-only mode', {
        error: storageError instanceof Error ? storageError.message : String(storageError),
      });
    }

    // Create and initialize gateway server
    gatewayServer = createGatewayServer({ config });
    await gatewayServer.initialize();

    // Enable hot reload if configured (only in single process or primary)
    // In cluster mode, primary handles restarts, but hot reload of config logic
    // usually requires IPC. For simplicity, we disable hot reload watcher in workers for now.
    if (config.hotReload && !cluster.isWorker) {
      const configLoader = getConfigLoader();
      configLoader.startWatching();
    }

    // Start listening for requests
    await gatewayServer.start();

    if (!cluster.isWorker) {
       printBanner(config, 1);
    } else {
       logLifecycle('ready', `Worker ${process.pid} listening`);
    }

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

function printBanner(config: AegisConfig, numWorkers: number): void {
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
║    Workers:     ${String(numWorkers).padEnd(12)}                                 ║
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
