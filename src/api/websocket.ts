/**
 * AEGIS - WebSocket Handler for Real-time Metrics
 *
 * Provides WebSocket connections for streaming real-time metrics
 * to the dashboard. Supports subscriptions for different metric types.
 */

import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { getMetricsCollector } from '../monitoring/collector.js';
import type {
  DashboardOverview,
  RealtimeMetricUpdate,
  MetricSubscription,
  Alert,
} from '../monitoring/types.js';
import logger from '../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended WebSocket with subscription info
 */
interface MetricsWebSocket extends WebSocket {
  isAlive: boolean;
  subscription: MetricSubscription;
  clientId: string;
}

/**
 * WebSocket message types
 */
type MessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'ping'
  | 'pong'
  | 'metrics'
  | 'alert'
  | 'error'
  | 'connected';

/**
 * WebSocket message structure
 */
interface WsMessage {
  type: MessageType;
  data?: unknown;
  timestamp?: string;
}

/**
 * WebSocket server options
 */
export interface MetricsWebSocketOptions {
  /**
   * Update interval in milliseconds (default: 1000)
   */
  updateInterval?: number;

  /**
   * Ping interval for keep-alive in milliseconds (default: 30000)
   */
  pingInterval?: number;

  /**
   * Maximum connections per IP (default: 10)
   */
  maxConnectionsPerIp?: number;

  /**
   * Enable authentication (default: false)
   */
  requireAuth?: boolean;

  /**
   * Path for WebSocket endpoint (default: '/ws/metrics')
   */
  path?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_OPTIONS: Required<MetricsWebSocketOptions> = {
  updateInterval: 1000,
  pingInterval: 30000,
  maxConnectionsPerIp: 10,
  requireAuth: false,
  path: '/ws/metrics',
};

// =============================================================================
// WebSocket Server Class
// =============================================================================

export class MetricsWebSocketServer {
  private wss: WebSocketServer | null = null;
  private options: Required<MetricsWebSocketOptions>;
  private updateTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private connectionsByIp = new Map<string, number>();
  private clientCounter = 0;

  constructor(options: MetricsWebSocketOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Initialize WebSocket server on an existing HTTP server
   */
  public initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: this.options.path,
      // Allow connections from any origin (for development)
      verifyClient: ({ origin, req }, callback) => {
        // In development, allow all origins
        // In production, you might want to restrict this
        logger.debug('WebSocket connection attempt', { origin, url: req.url });
        callback(true);
      },
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    this.wss.on('error', this.handleServerError.bind(this));

    // Start periodic updates
    this.startUpdateTimer();

    // Start ping timer for keep-alive
    this.startPingTimer();

    logger.info('WebSocket server initialized', {
      path: this.options.path,
      updateInterval: this.options.updateInterval,
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const metricsWs = ws as MetricsWebSocket;

    // Get client IP
    const clientIp = this.getClientIp(req);

    // Check connection limit per IP
    const currentConnections = this.connectionsByIp.get(clientIp) || 0;
    if (currentConnections >= this.options.maxConnectionsPerIp) {
      this.sendMessage(ws, {
        type: 'error',
        data: { message: 'Too many connections from this IP' },
      });
      ws.close(1008, 'Too many connections');
      return;
    }

    // Track connection
    this.connectionsByIp.set(clientIp, currentConnections + 1);
    this.clientCounter++;

    // Initialize client
    metricsWs.isAlive = true;
    metricsWs.clientId = `client-${this.clientCounter}`;
    metricsWs.subscription = {
      type: 'overview',
      interval: this.options.updateInterval,
    };

    // Send connected message
    this.sendMessage(ws, {
      type: 'connected',
      data: {
        clientId: metricsWs.clientId,
        subscription: metricsWs.subscription,
      },
    });

    // Handle messages
    ws.on('message', (data: RawData) => this.handleMessage(metricsWs, data));

    // Handle pong for keep-alive
    ws.on('pong', () => {
      metricsWs.isAlive = true;
    });

    // Handle close
    ws.on('close', () => {
      const count = this.connectionsByIp.get(clientIp) || 1;
      if (count <= 1) {
        this.connectionsByIp.delete(clientIp);
      } else {
        this.connectionsByIp.set(clientIp, count - 1);
      }

      logger.debug('WebSocket client disconnected', {
        clientId: metricsWs.clientId,
        ip: clientIp,
      });
    });

    // Handle errors
    ws.on('error', (error: Error) => {
      logger.error('WebSocket client error', {
        clientId: metricsWs.clientId,
        error: error.message,
      });
    });

    logger.debug('WebSocket client connected', {
      clientId: metricsWs.clientId,
      ip: clientIp,
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(ws: MetricsWebSocket, data: RawData): void {
    try {
      const message = JSON.parse(data.toString()) as WsMessage;

      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(ws, message.data as Partial<MetricSubscription>);
          break;

        case 'unsubscribe':
          ws.subscription = { type: 'all' };
          this.sendMessage(ws, { type: 'unsubscribe', data: { success: true } });
          break;

        case 'ping':
          this.sendMessage(ws, { type: 'pong' });
          break;

        default:
          this.sendMessage(ws, {
            type: 'error',
            data: { message: `Unknown message type: ${message.type}` },
          });
      }
    } catch {
      this.sendMessage(ws, {
        type: 'error',
        data: { message: 'Invalid message format' },
      });
    }
  }

  /**
   * Handle subscription request
   */
  private handleSubscribe(ws: MetricsWebSocket, subscription: Partial<MetricSubscription>): void {
    // Validate subscription type
    const validTypes = ['all', 'requests', 'rateLimits', 'backends', 'overview'];
    const type = subscription.type || 'overview';

    if (!validTypes.includes(type)) {
      this.sendMessage(ws, {
        type: 'error',
        data: { message: `Invalid subscription type: ${type}` },
      });
      return;
    }

    // Update subscription
    ws.subscription = {
      type: type as MetricSubscription['type'],
      interval: subscription.interval || this.options.updateInterval,
      filters: subscription.filters,
    };

    this.sendMessage(ws, {
      type: 'subscribe',
      data: { success: true, subscription: ws.subscription },
    });

    // Send immediate update
    void this.sendMetricsToClient(ws);
  }

  /**
   * Start periodic update timer
   */
  private startUpdateTimer(): void {
    this.updateTimer = setInterval(() => {
      void this.broadcastMetrics();
    }, this.options.updateInterval);
  }

  /**
   * Start periodic ping timer for keep-alive
   */
  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      this.wss?.clients.forEach((client: WebSocket) => {
        const metricsWs = client as MetricsWebSocket;

        if (!metricsWs.isAlive) {
          // Client didn't respond to last ping, terminate
          client.terminate();
          return;
        }

        metricsWs.isAlive = false;
        client.ping();
      });
    }, this.options.pingInterval);
  }

  /**
   * Broadcast metrics to all connected clients
   */
  private async broadcastMetrics(): Promise<void> {
    if (!this.wss || this.wss.clients.size === 0) {
      return;
    }

    const collector = getMetricsCollector();
    const overview = await collector.getOverview('1h');

    this.wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        const metricsWs = client as MetricsWebSocket;
        void this.sendMetricsToClient(metricsWs, overview);
      }
    });
  }

  /**
   * Send metrics to a specific client based on their subscription
   */
  private async sendMetricsToClient(
    ws: MetricsWebSocket,
    overview?: DashboardOverview
  ): Promise<void> {
    // Check if socket is open - cast to WebSocket to access readyState
    const socket = ws as unknown as WebSocket;
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const collector = getMetricsCollector();

      switch (ws.subscription.type) {
        case 'overview':
        case 'all': {
          const data = overview || (await collector.getOverview('1h'));
          const update: RealtimeMetricUpdate = {
            type: 'overview',
            timestamp: new Date(),
            data,
          };
          this.sendMessage(ws, { type: 'metrics', data: update });
          break;
        }

        case 'requests': {
          const stats = collector.getStats();
          this.sendMessage(ws, {
            type: 'metrics',
            data: {
              type: 'request',
              timestamp: new Date(),
              data: stats.realtimeCounters,
            },
          });
          break;
        }

        case 'rateLimits': {
          // Rate limit specific stats would go here
          const stats = collector.getStats();
          this.sendMessage(ws, {
            type: 'metrics',
            data: {
              type: 'rateLimit',
              timestamp: new Date(),
              data: {
                rateLimitedRequests: stats.realtimeCounters.rateLimitedRequests,
              },
            },
          });
          break;
        }

        case 'backends': {
          // Backend specific stats would go here
          this.sendMessage(ws, {
            type: 'metrics',
            data: {
              type: 'backend',
              timestamp: new Date(),
              data: {},
            },
          });
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to send metrics to client', {
        clientId: ws.clientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send a message to a WebSocket client
   */
  private sendMessage(ws: WebSocket, message: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          ...message,
          timestamp: new Date().toISOString(),
        })
      );
    }
  }

  /**
   * Get client IP from request
   */
  private getClientIp(req: IncomingMessage): string {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0];
      if (ips) {
        const firstIp = ips.split(',')[0];
        if (firstIp) {
          return firstIp.trim();
        }
      }
    }

    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Handle WebSocket server errors
   */
  private handleServerError(error: Error): void {
    logger.error('WebSocket server error', {
      error: error.message,
    });
  }

  /**
   * Broadcast a custom message to all clients
   */
  public broadcast(type: MessageType, data: unknown): void {
    if (!this.wss) {
      return;
    }

    this.wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        this.sendMessage(client, { type, data });
      }
    });
  }

  /**
   * Broadcast an alert to all connected clients
   */
  public broadcastAlert(alert: Alert): void {
    if (!this.wss) {
      return;
    }

    const message = {
      alert: {
        id: alert.id,
        ruleId: alert.ruleId,
        ruleName: alert.ruleName,
        severity: alert.severity,
        status: alert.status,
        message: alert.message,
        value: alert.value,
        threshold: alert.threshold,
        triggeredAt: alert.triggeredAt,
      },
      timestamp: new Date().toISOString(),
    };

    this.wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        this.sendMessage(client, { type: 'alert', data: message });
      }
    });

    logger.debug('Alert broadcasted to WebSocket clients', {
      alertId: alert.id,
      clientCount: this.wss.clients.size,
    });
  }

  /**
   * Get connection stats
   */
  public getStats(): {
    totalConnections: number;
    connectionsByIp: Record<string, number>;
  } {
    return {
      totalConnections: this.wss?.clients.size || 0,
      connectionsByIp: Object.fromEntries(this.connectionsByIp),
    };
  }

  /**
   * Shutdown the WebSocket server
   */
  public shutdown(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.wss) {
      // Close all connections
      this.wss.clients.forEach((client: WebSocket) => {
        client.close(1001, 'Server shutting down');
      });

      this.wss.close();
      this.wss = null;
    }

    logger.info('WebSocket server shut down');
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let wsServerInstance: MetricsWebSocketServer | null = null;

/**
 * Get the WebSocket server singleton instance
 */
export function getMetricsWebSocketServer(
  options?: MetricsWebSocketOptions
): MetricsWebSocketServer {
  if (wsServerInstance === null) {
    wsServerInstance = new MetricsWebSocketServer(options);
  }
  return wsServerInstance;
}

/**
 * Initialize WebSocket server on an HTTP server
 */
export function initializeMetricsWebSocket(
  server: HttpServer,
  options?: MetricsWebSocketOptions
): MetricsWebSocketServer {
  const wsServer = getMetricsWebSocketServer(options);
  wsServer.initialize(server);
  return wsServer;
}

/**
 * Shutdown the WebSocket server
 */
export function shutdownMetricsWebSocket(): void {
  if (wsServerInstance) {
    wsServerInstance.shutdown();
    wsServerInstance = null;
  }
}

export default MetricsWebSocketServer;
