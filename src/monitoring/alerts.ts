/**
 * AEGIS - Alert Rules Engine
 *
 * Threshold-based alert system that monitors metrics and triggers alerts
 * when conditions are met. Supports multiple notification channels and
 * alert lifecycle management.
 */

import { v4 as uuidv4 } from 'uuid';
import type { PostgresClient } from '../storage/postgres.js';
import logger from '../utils/logger.js';
import type {
  AlertRule,
  Alert,
  AlertHistoryEntry,
  AlertSeverity,
  AlertStatus,
  AlertMetric,
  AlertAction,
  AlertActionType,
  ComparisonOperator,
  AlertsConfig,
  SlackAlertConfig,
  WebhookAlertConfig,
  EmailAlertConfig,
  PagerDutyAlertConfig,
} from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Alert rule input for creation/update
 */
export interface AlertRuleInput {
  name: string;
  description?: string;
  enabled?: boolean;
  severity: AlertSeverity;
  condition: {
    metric: AlertMetric;
    operator: ComparisonOperator;
    threshold: number;
    window: string;
    endpoint?: string;
    backend?: string;
  };
  actions: AlertAction[];
  cooldown?: string;
}

/**
 * Alert trigger input
 */
export interface AlertTriggerInput {
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  message: string;
  value: number;
  threshold: number;
  metadata?: Record<string, unknown>;
}

/**
 * Metric value fetcher function type
 */
export type MetricValueFetcher = (
  metric: AlertMetric,
  windowSeconds: number,
  endpoint?: string,
  backend?: string
) => Promise<number>;

/**
 * Notification result
 */
export interface NotificationResult {
  channel: AlertActionType;
  success: boolean;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: AlertsConfig = {
  enabled: true,
  checkIntervalMs: 60000, // 1 minute
  defaultCooldownMs: 300000, // 5 minutes
  maxActiveAlerts: 1000,
  retentionDays: 90,
  channels: {},
};

/**
 * Database row type for alert_rules table
 */
interface AlertRuleRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  severity: AlertSeverity;
  metric: AlertMetric;
  operator: ComparisonOperator;
  threshold: number;
  window_seconds: number;
  endpoint: string | null;
  backend: string | null;
  actions: string | AlertAction[];
  cooldown_seconds: number | null;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
}

/**
 * Database row type for alerts table
 */
interface AlertRow {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  value: number;
  threshold: number;
  triggered_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  muted_until: string | null;
  metadata: string | Record<string, unknown> | null;
}

const WINDOW_SECONDS: Record<string, number | undefined> = {
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
};

// =============================================================================
// Alert Manager Class
// =============================================================================

export class AlertManager {
  private config: AlertsConfig;
  private db: PostgresClient | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private metricFetcher: MetricValueFetcher | null = null;

  // In-memory cache for rules and active alerts
  private rulesCache = new Map<string, AlertRule>();
  private activeAlertsCache = new Map<string, Alert>();
  private lastTriggeredAt = new Map<string, Date>();

  constructor(config: Partial<AlertsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the alert manager with a database connection
   */
  public async initialize(db: PostgresClient, metricFetcher: MetricValueFetcher): Promise<void> {
    this.db = db;
    this.metricFetcher = metricFetcher;

    // Load rules from database
    await this.loadRulesFromDb();

    // Load active alerts from database
    await this.loadActiveAlertsFromDb();

    // Start periodic check
    if (this.config.enabled) {
      this.startCheckTimer();
    }

    logger.info('Alert manager initialized', {
      enabled: this.config.enabled,
      checkIntervalMs: this.config.checkIntervalMs,
      rulesCount: this.rulesCache.size,
      activeAlertsCount: this.activeAlertsCache.size,
    });
  }

  /**
   * Shutdown the alert manager
   */
  public async shutdown(): Promise<void> {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    logger.info('Alert manager shut down');
  }

  /**
   * Set the metric value fetcher function
   */
  public setMetricFetcher(fetcher: MetricValueFetcher): void {
    this.metricFetcher = fetcher;
  }

  // ===========================================================================
  // Rule Management
  // ===========================================================================

  /**
   * Create a new alert rule
   */
  public async createRule(input: AlertRuleInput): Promise<AlertRule> {
    const now = new Date();
    const rule: AlertRule = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? true,
      severity: input.severity,
      condition: input.condition,
      actions: input.actions,
      cooldown: input.cooldown,
      createdAt: now,
      updatedAt: now,
    };

    // Save to database
    if (this.db) {
      const windowSeconds = this.parseWindow(rule.condition.window);
      const cooldownSeconds = rule.cooldown ? this.parseWindow(rule.cooldown) : null;

      await this.db.query(
        `INSERT INTO alert_rules (
          id, name, description, enabled, severity,
          metric, operator, threshold, window_seconds, endpoint, backend,
          actions, cooldown_seconds, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          rule.id,
          rule.name,
          rule.description || null,
          rule.enabled,
          rule.severity,
          rule.condition.metric,
          rule.condition.operator,
          rule.condition.threshold,
          windowSeconds,
          rule.condition.endpoint || null,
          rule.condition.backend || null,
          JSON.stringify(rule.actions),
          cooldownSeconds,
          rule.createdAt,
          rule.updatedAt,
        ]
      );
    }

    // Add to cache
    this.rulesCache.set(rule.id, rule);

    logger.info('Alert rule created', { ruleId: rule.id, name: rule.name });

    return rule;
  }

  /**
   * Update an existing alert rule
   */
  public async updateRule(
    ruleId: string,
    updates: Partial<AlertRuleInput>
  ): Promise<AlertRule | null> {
    const existing = this.rulesCache.get(ruleId);
    if (!existing) {
      return null;
    }

    const updated: AlertRule = {
      ...existing,
      ...updates,
      condition: updates.condition
        ? { ...existing.condition, ...updates.condition }
        : existing.condition,
      updatedAt: new Date(),
    };

    // Save to database
    if (this.db) {
      const windowSeconds = this.parseWindow(updated.condition.window);
      const cooldownSeconds = updated.cooldown ? this.parseWindow(updated.cooldown) : null;

      await this.db.query(
        `UPDATE alert_rules SET
          name = $2, description = $3, enabled = $4, severity = $5,
          metric = $6, operator = $7, threshold = $8, window_seconds = $9,
          endpoint = $10, backend = $11, actions = $12, cooldown_seconds = $13,
          updated_at = $14
        WHERE id = $1`,
        [
          ruleId,
          updated.name,
          updated.description || null,
          updated.enabled,
          updated.severity,
          updated.condition.metric,
          updated.condition.operator,
          updated.condition.threshold,
          windowSeconds,
          updated.condition.endpoint || null,
          updated.condition.backend || null,
          JSON.stringify(updated.actions),
          cooldownSeconds,
          updated.updatedAt,
        ]
      );
    }

    // Update cache
    this.rulesCache.set(ruleId, updated);

    logger.info('Alert rule updated', { ruleId, name: updated.name });

    return updated;
  }

  /**
   * Delete an alert rule
   */
  public async deleteRule(ruleId: string): Promise<boolean> {
    if (!this.rulesCache.has(ruleId)) {
      return false;
    }

    // Delete from database (cascades to alerts)
    if (this.db) {
      await this.db.query('DELETE FROM alert_rules WHERE id = $1', [ruleId]);
    }

    // Remove from cache
    this.rulesCache.delete(ruleId);
    this.lastTriggeredAt.delete(ruleId);

    logger.info('Alert rule deleted', { ruleId });

    return true;
  }

  /**
   * Get a rule by ID
   */
  public getRule(ruleId: string): AlertRule | undefined {
    return this.rulesCache.get(ruleId);
  }

  /**
   * Get all rules
   */
  public getRules(): AlertRule[] {
    return Array.from(this.rulesCache.values());
  }

  /**
   * Enable or disable a rule
   */
  public async setRuleEnabled(ruleId: string, enabled: boolean): Promise<boolean> {
    const rule = this.rulesCache.get(ruleId);
    if (!rule) {
      return false;
    }

    rule.enabled = enabled;
    rule.updatedAt = new Date();

    if (this.db) {
      await this.db.query('UPDATE alert_rules SET enabled = $2, updated_at = $3 WHERE id = $1', [
        ruleId,
        enabled,
        rule.updatedAt,
      ]);
    }

    logger.info('Alert rule enabled state changed', { ruleId, enabled });

    return true;
  }

  // ===========================================================================
  // Alert Management
  // ===========================================================================

  /**
   * Trigger an alert
   */
  public async trigger(input: AlertTriggerInput): Promise<Alert> {
    const now = new Date();
    const alert: Alert = {
      id: uuidv4(),
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      severity: input.severity,
      status: 'active',
      message: input.message,
      value: input.value,
      threshold: input.threshold,
      triggeredAt: now,
      metadata: input.metadata,
    };

    // Save to database
    if (this.db) {
      await this.db.query(
        `INSERT INTO alerts (
          id, rule_id, rule_name, severity, status,
          message, value, threshold, triggered_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          alert.id,
          alert.ruleId,
          alert.ruleName,
          alert.severity,
          alert.status,
          alert.message,
          alert.value,
          alert.threshold,
          alert.triggeredAt,
          alert.metadata ? JSON.stringify(alert.metadata) : null,
        ]
      );

      // Add history entry
      await this.addHistoryEntry(alert.id, 'triggered');

      // Update rule's last triggered timestamp
      await this.db.query('UPDATE alert_rules SET last_triggered_at = $2 WHERE id = $1', [
        alert.ruleId,
        now,
      ]);
    }

    // Add to cache
    this.activeAlertsCache.set(alert.id, alert);
    this.lastTriggeredAt.set(alert.ruleId, now);

    // Check cache size limit
    if (this.activeAlertsCache.size > this.config.maxActiveAlerts) {
      this.pruneOldAlerts();
    }

    logger.warn('Alert triggered', {
      alertId: alert.id,
      ruleId: alert.ruleId,
      severity: alert.severity,
      message: alert.message,
    });

    // Send notifications
    const rule = this.rulesCache.get(alert.ruleId);
    if (rule) {
      await this.sendNotifications(alert, rule.actions);
    }

    return alert;
  }

  /**
   * Acknowledge an alert
   */
  public async acknowledge(
    alertId: string,
    acknowledgedBy: string,
    note?: string
  ): Promise<Alert | null> {
    const alert = this.activeAlertsCache.get(alertId);
    if (!alert || alert.status !== 'active') {
      return null;
    }

    const now = new Date();
    alert.status = 'acknowledged';
    alert.acknowledgedAt = now;
    alert.acknowledgedBy = acknowledgedBy;

    if (this.db) {
      await this.db.query(
        `UPDATE alerts SET
          status = $2, acknowledged_at = $3, acknowledged_by = $4
        WHERE id = $1`,
        [alertId, 'acknowledged', now, acknowledgedBy]
      );

      await this.addHistoryEntry(alertId, 'acknowledged', acknowledgedBy, note);
    }

    logger.info('Alert acknowledged', { alertId, acknowledgedBy });

    return alert;
  }

  /**
   * Resolve an alert
   */
  public async resolve(alertId: string, userId?: string, note?: string): Promise<Alert | null> {
    const alert = this.activeAlertsCache.get(alertId);
    if (!alert) {
      return null;
    }

    const now = new Date();
    alert.status = 'resolved';
    alert.resolvedAt = now;

    if (this.db) {
      await this.db.query('UPDATE alerts SET status = $2, resolved_at = $3 WHERE id = $1', [
        alertId,
        'resolved',
        now,
      ]);

      await this.addHistoryEntry(alertId, 'resolved', userId, note);
    }

    // Remove from active cache
    this.activeAlertsCache.delete(alertId);

    logger.info('Alert resolved', { alertId });

    return alert;
  }

  /**
   * Mute an alert for a specified duration
   */
  public async mute(alertId: string, duration: string, userId?: string): Promise<Alert | null> {
    const alert = this.activeAlertsCache.get(alertId);
    if (!alert) {
      return null;
    }

    const durationSeconds = this.parseWindow(duration);
    const mutedUntil = new Date(Date.now() + durationSeconds * 1000);

    alert.status = 'muted';
    alert.mutedUntil = mutedUntil;

    if (this.db) {
      await this.db.query('UPDATE alerts SET status = $2, muted_until = $3 WHERE id = $1', [
        alertId,
        'muted',
        mutedUntil,
      ]);

      await this.addHistoryEntry(alertId, 'muted', userId, `Muted for ${duration}`);
    }

    logger.info('Alert muted', { alertId, mutedUntil });

    return alert;
  }

  /**
   * Unmute an alert
   */
  public async unmute(alertId: string, userId?: string): Promise<Alert | null> {
    const alert = this.activeAlertsCache.get(alertId);
    if (!alert || alert.status !== 'muted') {
      return null;
    }

    alert.status = 'active';
    alert.mutedUntil = undefined;

    if (this.db) {
      await this.db.query('UPDATE alerts SET status = $2, muted_until = NULL WHERE id = $1', [
        alertId,
        'active',
      ]);

      await this.addHistoryEntry(alertId, 'unmuted', userId);
    }

    logger.info('Alert unmuted', { alertId });

    return alert;
  }

  /**
   * Get an alert by ID
   */
  public getAlert(alertId: string): Alert | undefined {
    return this.activeAlertsCache.get(alertId);
  }

  /**
   * Get all active alerts
   */
  public getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlertsCache.values()).filter(
      (alert) => alert.status === 'active' || alert.status === 'acknowledged'
    );
  }

  /**
   * Get alerts by status
   */
  public getAlertsByStatus(status: AlertStatus): Alert[] {
    return Array.from(this.activeAlertsCache.values()).filter((alert) => alert.status === status);
  }

  /**
   * Get alerts by severity
   */
  public getAlertsBySeverity(severity: AlertSeverity): Alert[] {
    return Array.from(this.activeAlertsCache.values()).filter(
      (alert) => alert.severity === severity
    );
  }

  /**
   * Get alert history from database
   */
  public async getAlertHistory(
    alertId?: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<AlertHistoryEntry[]> {
    if (!this.db) {
      return [];
    }

    let query = `
      SELECT id, alert_id, action, timestamp, user_id, note
      FROM alert_history
    `;
    const params: unknown[] = [];

    if (alertId) {
      query += ' WHERE alert_id = $1';
      params.push(alertId);
    }

    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const rows = await this.db.query<{
      id: string;
      alert_id: string;
      action: AlertHistoryEntry['action'];
      timestamp: string;
      user_id: string | null;
      note: string | null;
    }>(query, params);

    return rows.map((row) => ({
      id: row.id,
      alertId: row.alert_id,
      action: row.action,
      timestamp: new Date(row.timestamp),
      userId: row.user_id || undefined,
      note: row.note || undefined,
    }));
  }

  /**
   * Get alerts list (including resolved) from database
   */
  public async getAlerts(options: {
    status?: AlertStatus;
    severity?: AlertSeverity;
    ruleId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ alerts: Alert[]; total: number }> {
    if (!this.db) {
      const alerts = Array.from(this.activeAlertsCache.values());
      return { alerts, total: alerts.length };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (options.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(options.severity);
    }

    if (options.ruleId) {
      conditions.push(`rule_id = $${paramIndex++}`);
      params.push(options.ruleId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM alerts ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0]?.count || '0', 10);

    // Get paginated results
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const rows = await this.db.query<AlertRow>(
      `SELECT * FROM alerts ${whereClause}
       ORDER BY triggered_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    const alerts = rows.map((row) => this.mapAlertRowTyped(row));

    return { alerts, total };
  }

  // ===========================================================================
  // Alert Checking
  // ===========================================================================

  /**
   * Start the periodic alert check timer
   */
  private startCheckTimer(): void {
    this.checkTimer = setInterval(() => {
      void this.checkAllRules();
    }, this.config.checkIntervalMs);

    logger.info('Alert check timer started', {
      intervalMs: this.config.checkIntervalMs,
    });
  }

  /**
   * Check all enabled rules against current metrics
   */
  public async checkAllRules(): Promise<void> {
    if (!this.metricFetcher) {
      logger.warn('No metric fetcher configured, skipping alert checks');
      return;
    }

    const enabledRules = Array.from(this.rulesCache.values()).filter((rule) => rule.enabled);

    logger.debug('Checking alert rules', { count: enabledRules.length });

    for (const rule of enabledRules) {
      try {
        await this.checkRule(rule);
      } catch (error) {
        logger.error('Error checking alert rule', {
          ruleId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Check for auto-resolving muted alerts
    await this.checkMutedAlerts();
  }

  /**
   * Check a single rule against current metrics
   */
  private async checkRule(rule: AlertRule): Promise<void> {
    if (!this.metricFetcher) {
      return;
    }

    // Check cooldown
    const lastTriggered = this.lastTriggeredAt.get(rule.id);
    if (lastTriggered) {
      const cooldownMs = rule.cooldown
        ? this.parseWindow(rule.cooldown) * 1000
        : this.config.defaultCooldownMs;

      if (Date.now() - lastTriggered.getTime() < cooldownMs) {
        return; // Still in cooldown period
      }
    }

    // Get current metric value
    const windowSeconds = this.parseWindow(rule.condition.window);
    const value = await this.metricFetcher(
      rule.condition.metric,
      windowSeconds,
      rule.condition.endpoint,
      rule.condition.backend
    );

    // Check condition
    const conditionMet = this.evaluateCondition(
      value,
      rule.condition.operator,
      rule.condition.threshold
    );

    if (conditionMet) {
      // Check if there's already an active alert for this rule
      const existingAlert = Array.from(this.activeAlertsCache.values()).find(
        (alert) =>
          alert.ruleId === rule.id && (alert.status === 'active' || alert.status === 'acknowledged')
      );

      if (!existingAlert) {
        // Trigger new alert
        await this.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: this.buildAlertMessage(rule, value),
          value,
          threshold: rule.condition.threshold,
          metadata: {
            metric: rule.condition.metric,
            window: rule.condition.window,
            endpoint: rule.condition.endpoint,
            backend: rule.condition.backend,
          },
        });
      }
    } else {
      // Auto-resolve active alerts for this rule if condition is no longer met
      const activeAlerts = Array.from(this.activeAlertsCache.values()).filter(
        (alert) => alert.ruleId === rule.id && alert.status === 'active'
      );

      for (const alert of activeAlerts) {
        await this.resolve(alert.id, undefined, 'Auto-resolved: condition no longer met');
      }
    }
  }

  /**
   * Evaluate alert condition
   */
  private evaluateCondition(
    value: number,
    operator: ComparisonOperator,
    threshold: number
  ): boolean {
    switch (operator) {
      case '>':
        return value > threshold;
      case '>=':
        return value >= threshold;
      case '<':
        return value < threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      default:
        return false;
    }
  }

  /**
   * Build alert message from rule and value
   */
  private buildAlertMessage(rule: AlertRule, value: number): string {
    const metricName = this.formatMetricName(rule.condition.metric);
    const operatorText = this.formatOperator(rule.condition.operator);

    let message = `${metricName} ${operatorText} ${rule.condition.threshold}`;
    message += ` (current value: ${value.toFixed(2)})`;

    if (rule.condition.endpoint) {
      message += ` for endpoint ${rule.condition.endpoint}`;
    }

    if (rule.condition.backend) {
      message += ` on backend ${rule.condition.backend}`;
    }

    return message;
  }

  /**
   * Format metric name for display
   */
  private formatMetricName(metric: AlertMetric): string {
    const names: Record<AlertMetric, string> = {
      latency_p95: 'P95 Latency',
      latency_p99: 'P99 Latency',
      latency_avg: 'Average Latency',
      error_rate: 'Error Rate',
      request_rate: 'Request Rate',
      rate_limit_hits: 'Rate Limit Hits',
      backend_health: 'Backend Health',
      active_connections: 'Active Connections',
    };
    return names[metric] || metric;
  }

  /**
   * Format operator for display
   */
  private formatOperator(operator: ComparisonOperator): string {
    const texts: Record<ComparisonOperator, string> = {
      '>': 'exceeded',
      '>=': 'reached or exceeded',
      '<': 'dropped below',
      '<=': 'at or below',
      '==': 'equals',
      '!=': 'not equal to',
    };
    return texts[operator] || operator;
  }

  /**
   * Check and auto-unmute muted alerts
   */
  private async checkMutedAlerts(): Promise<void> {
    const now = new Date();
    const mutedAlerts = this.getAlertsByStatus('muted');

    for (const alert of mutedAlerts) {
      if (alert.mutedUntil && alert.mutedUntil <= now) {
        await this.unmute(alert.id, undefined);
      }
    }
  }

  // ===========================================================================
  // Notifications
  // ===========================================================================

  /**
   * Send notifications through configured channels
   */
  public async sendNotifications(
    alert: Alert,
    actions: AlertAction[]
  ): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];

    for (const action of actions) {
      try {
        let success = false;
        let error: string | undefined;

        switch (action.type) {
          case 'log':
            success = this.sendLogNotification(alert);
            break;

          case 'slack':
            success = await this.sendSlackNotification(
              alert,
              action.config as Partial<SlackAlertConfig>
            );
            break;

          case 'webhook':
            success = await this.sendWebhookNotification(
              alert,
              action.config as Partial<WebhookAlertConfig>
            );
            break;

          case 'email':
            success = await this.sendEmailNotification(
              alert,
              action.config as Partial<EmailAlertConfig>
            );
            break;

          case 'pagerduty':
            success = await this.sendPagerDutyNotification(
              alert,
              action.config as Partial<PagerDutyAlertConfig>
            );
            break;

          default:
            error = `Unknown notification type: ${action.type}`;
        }

        results.push({ channel: action.type, success, error });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Failed to send notification', {
          alertId: alert.id,
          channel: action.type,
          error,
        });
        results.push({ channel: action.type, success: false, error });
      }
    }

    return results;
  }

  /**
   * Send log notification (always works)
   */
  private sendLogNotification(alert: Alert): boolean {
    const logLevel =
      alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warn' : 'info';

    logger[logLevel]('ALERT', {
      alertId: alert.id,
      ruleName: alert.ruleName,
      severity: alert.severity,
      message: alert.message,
      value: alert.value,
      threshold: alert.threshold,
    });

    return true;
  }

  /**
   * Send Slack notification
   */
  private async sendSlackNotification(
    alert: Alert,
    config: Partial<SlackAlertConfig>
  ): Promise<boolean> {
    const webhookUrl = config.webhookUrl || this.config.channels.slack?.webhookUrl;
    if (!webhookUrl) {
      logger.warn('Slack webhook URL not configured');
      return false;
    }

    const color =
      alert.severity === 'critical'
        ? '#dc3545'
        : alert.severity === 'warning'
          ? '#ffc107'
          : '#17a2b8';

    const payload = {
      channel: config.channel || this.config.channels.slack?.channel,
      username: config.username || this.config.channels.slack?.username || 'AEGIS Alerts',
      icon_emoji: config.iconEmoji || this.config.channels.slack?.iconEmoji || ':warning:',
      attachments: [
        {
          color,
          title: `[${alert.severity.toUpperCase()}] ${alert.ruleName}`,
          text: alert.message,
          fields: [
            { title: 'Value', value: alert.value.toFixed(2), short: true },
            { title: 'Threshold', value: alert.threshold.toString(), short: true },
            { title: 'Alert ID', value: alert.id, short: true },
            { title: 'Triggered', value: alert.triggeredAt.toISOString(), short: true },
          ],
          footer: 'AEGIS Gateway',
          ts: Math.floor(alert.triggeredAt.getTime() / 1000),
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }

    logger.info('Slack notification sent', { alertId: alert.id });
    return true;
  }

  /**
   * Send webhook notification
   */
  private async sendWebhookNotification(
    alert: Alert,
    config: Partial<WebhookAlertConfig>
  ): Promise<boolean> {
    const url = config.url || this.config.channels.webhook?.url;
    if (!url) {
      logger.warn('Webhook URL not configured');
      return false;
    }

    const method = config.method || this.config.channels.webhook?.method || 'POST';
    const headers = {
      'Content-Type': 'application/json',
      ...this.config.channels.webhook?.headers,
      ...config.headers,
    };

    const payload = {
      alert: {
        id: alert.id,
        ruleId: alert.ruleId,
        ruleName: alert.ruleName,
        severity: alert.severity,
        status: alert.status,
        message: alert.message,
        value: alert.value,
        threshold: alert.threshold,
        triggeredAt: alert.triggeredAt.toISOString(),
        metadata: alert.metadata,
      },
      timestamp: new Date().toISOString(),
    };

    const timeout = config.timeout || this.config.channels.webhook?.timeout || 10000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Webhook error: ${response.status}`);
      }

      logger.info('Webhook notification sent', { alertId: alert.id, url });
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Send email notification (placeholder - requires email service integration)
   */
  private async sendEmailNotification(
    alert: Alert,
    _config: Partial<EmailAlertConfig>
  ): Promise<boolean> {
    // Email sending requires SMTP integration (nodemailer or similar)
    // This is a placeholder that logs the intent
    logger.info('Email notification would be sent', {
      alertId: alert.id,
      severity: alert.severity,
    });

    // In production, integrate with nodemailer or an email service
    // For now, return true to indicate the notification was "handled"
    return true;
  }

  /**
   * Send PagerDuty notification
   */
  private async sendPagerDutyNotification(
    alert: Alert,
    config: Partial<PagerDutyAlertConfig>
  ): Promise<boolean> {
    const integrationKey = config.integrationKey || this.config.channels.pagerduty?.integrationKey;
    if (!integrationKey) {
      logger.warn('PagerDuty integration key not configured');
      return false;
    }

    const apiUrl =
      config.apiUrl ||
      this.config.channels.pagerduty?.apiUrl ||
      'https://events.pagerduty.com/v2/enqueue';

    const severity =
      alert.severity === 'critical'
        ? 'critical'
        : alert.severity === 'warning'
          ? 'warning'
          : 'info';

    const payload = {
      routing_key: integrationKey,
      event_action: 'trigger',
      dedup_key: `aegis-${alert.ruleId}`,
      payload: {
        summary: `[${alert.severity.toUpperCase()}] ${alert.ruleName}: ${alert.message}`,
        severity,
        source: 'AEGIS Gateway',
        timestamp: alert.triggeredAt.toISOString(),
        custom_details: {
          alert_id: alert.id,
          rule_id: alert.ruleId,
          value: alert.value,
          threshold: alert.threshold,
          metadata: alert.metadata,
        },
      },
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`PagerDuty API error: ${response.status}`);
    }

    logger.info('PagerDuty notification sent', { alertId: alert.id });
    return true;
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Parse window string to seconds
   */
  private parseWindow(window: string): number {
    const predefined = WINDOW_SECONDS[window];
    if (predefined !== undefined) {
      return predefined;
    }

    // Parse custom format like "2h", "30m", etc.
    const match = window.match(/^(\d+)(s|m|h|d)$/);
    if (match && match[1] && match[2]) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      const multipliers: Record<string, number> = {
        s: 1,
        m: 60,
        h: 3600,
        d: 86400,
      };
      return value * (multipliers[unit] || 1);
    }

    return 60; // Default to 1 minute
  }

  /**
   * Load rules from database
   */
  private async loadRulesFromDb(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      const rows = await this.db.query<AlertRuleRow>('SELECT * FROM alert_rules');

      for (const row of rows) {
        const rule: AlertRule = {
          id: row.id,
          name: row.name,
          description: row.description || undefined,
          enabled: row.enabled,
          severity: row.severity,
          condition: {
            metric: row.metric,
            operator: row.operator,
            threshold: row.threshold,
            window: this.secondsToWindow(row.window_seconds),
            endpoint: row.endpoint || undefined,
            backend: row.backend || undefined,
          },
          actions: typeof row.actions === 'string' ? JSON.parse(row.actions) : row.actions,
          cooldown: row.cooldown_seconds ? this.secondsToWindow(row.cooldown_seconds) : undefined,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };

        this.rulesCache.set(rule.id, rule);

        if (row.last_triggered_at) {
          this.lastTriggeredAt.set(rule.id, new Date(row.last_triggered_at));
        }
      }

      logger.info('Loaded alert rules from database', { count: this.rulesCache.size });
    } catch (error) {
      logger.error('Failed to load alert rules from database', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load active alerts from database
   */
  private async loadActiveAlertsFromDb(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      const rows = await this.db.query<AlertRow>(
        `SELECT * FROM alerts WHERE status IN ('active', 'acknowledged', 'muted')`
      );

      for (const row of rows) {
        const alert = this.mapAlertRowTyped(row);
        this.activeAlertsCache.set(alert.id, alert);
      }

      logger.info('Loaded active alerts from database', { count: this.activeAlertsCache.size });
    } catch (error) {
      logger.error('Failed to load active alerts from database', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Map typed database row to Alert object
   */
  private mapAlertRowTyped(row: AlertRow): Alert {
    return {
      id: row.id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      severity: row.severity,
      status: row.status,
      message: row.message,
      value: row.value,
      threshold: row.threshold,
      triggeredAt: new Date(row.triggered_at),
      acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at) : undefined,
      acknowledgedBy: row.acknowledged_by || undefined,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
      mutedUntil: row.muted_until ? new Date(row.muted_until) : undefined,
      metadata: row.metadata
        ? typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : row.metadata
        : undefined,
    };
  }

  /**
   * Convert seconds to window string
   */
  private secondsToWindow(seconds: number): string {
    if (seconds >= 86400 && seconds % 86400 === 0) {
      return `${seconds / 86400}d`;
    }
    if (seconds >= 3600 && seconds % 3600 === 0) {
      return `${seconds / 3600}h`;
    }
    if (seconds >= 60 && seconds % 60 === 0) {
      return `${seconds / 60}m`;
    }
    return `${seconds}s`;
  }

  /**
   * Add alert history entry
   */
  private async addHistoryEntry(
    alertId: string,
    action: AlertHistoryEntry['action'],
    userId?: string,
    note?: string
  ): Promise<void> {
    if (!this.db) {
      return;
    }

    await this.db.query(
      `INSERT INTO alert_history (id, alert_id, action, timestamp, user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), alertId, action, new Date(), userId || null, note || null]
    );
  }

  /**
   * Prune old resolved alerts from cache
   */
  private pruneOldAlerts(): void {
    // Remove resolved alerts from cache (keep only active/acknowledged/muted)
    const toRemove: string[] = [];

    for (const [id, alert] of this.activeAlertsCache) {
      if (alert.status === 'resolved') {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.activeAlertsCache.delete(id);
    }

    logger.debug('Pruned old alerts from cache', { removed: toRemove.length });
  }

  /**
   * Get alert manager stats
   */
  public getStats(): {
    rulesCount: number;
    enabledRulesCount: number;
    activeAlertsCount: number;
    alertsByStatus: Record<AlertStatus, number>;
    alertsBySeverity: Record<AlertSeverity, number>;
  } {
    const alerts = Array.from(this.activeAlertsCache.values());

    const alertsByStatus: Record<AlertStatus, number> = {
      active: 0,
      acknowledged: 0,
      resolved: 0,
      muted: 0,
    };

    const alertsBySeverity: Record<AlertSeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
    };

    for (const alert of alerts) {
      alertsByStatus[alert.status]++;
      alertsBySeverity[alert.severity]++;
    }

    return {
      rulesCount: this.rulesCache.size,
      enabledRulesCount: Array.from(this.rulesCache.values()).filter((r) => r.enabled).length,
      activeAlertsCount: alertsByStatus.active + alertsByStatus.acknowledged,
      alertsByStatus,
      alertsBySeverity,
    };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let alertManagerInstance: AlertManager | null = null;

/**
 * Get the alert manager singleton instance
 */
export function getAlertManager(config?: Partial<AlertsConfig>): AlertManager {
  if (alertManagerInstance === null) {
    alertManagerInstance = new AlertManager(config);
  }
  return alertManagerInstance;
}

/**
 * Initialize the alert manager with database and metric fetcher
 */
export async function initializeAlertManager(
  db: PostgresClient,
  metricFetcher: MetricValueFetcher,
  config?: Partial<AlertsConfig>
): Promise<AlertManager> {
  const manager = getAlertManager(config);
  await manager.initialize(db, metricFetcher);
  return manager;
}

/**
 * Shutdown the alert manager
 */
export async function shutdownAlertManager(): Promise<void> {
  if (alertManagerInstance) {
    await alertManagerInstance.shutdown();
    alertManagerInstance = null;
  }
}

export default AlertManager;
