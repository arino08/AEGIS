/**
 * AEGIS - Alert Manager Unit Tests
 *
 * Tests for the alert rules engine, threshold-based alerts,
 * notification channels, and alert lifecycle management.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  AlertManager,
  getAlertManager,
  type AlertRuleInput,
  type MetricValueFetcher,
} from '../../src/monitoring/alerts.js';
import type { AlertSeverity, AlertMetric, ComparisonOperator } from '../../src/monitoring/types.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestRule(overrides: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return {
    name: 'Test Rule',
    description: 'A test alert rule',
    severity: 'warning',
    condition: {
      metric: 'latency_p95',
      operator: '>',
      threshold: 1000,
      window: '5m',
    },
    actions: [{ type: 'log', config: {} }],
    cooldown: '5m',
    ...overrides,
  };
}

// Mock metric fetcher
function createMockMetricFetcher(returnValue: number = 500): MetricValueFetcher {
  return jest.fn(async () => returnValue) as unknown as MetricValueFetcher;
}

// =============================================================================
// Tests
// =============================================================================

describe('AlertManager', () => {
  let alertManager: AlertManager;

  beforeEach(() => {
    alertManager = new AlertManager({
      enabled: true,
      checkIntervalMs: 60000,
      defaultCooldownMs: 300000,
      maxActiveAlerts: 100,
      retentionDays: 90,
      channels: {},
    });
  });

  afterEach(async () => {
    await alertManager.shutdown();
  });

  describe('Rule Management', () => {
    describe('createRule', () => {
      it('should create a new alert rule', async () => {
        const input = createTestRule();
        const rule = await alertManager.createRule(input);

        expect(rule).toBeDefined();
        expect(rule.id).toBeDefined();
        expect(rule.name).toBe(input.name);
        expect(rule.description).toBe(input.description);
        expect(rule.severity).toBe(input.severity);
        expect(rule.enabled).toBe(true);
        expect(rule.condition).toEqual(input.condition);
        expect(rule.actions).toEqual(input.actions);
        expect(rule.cooldown).toBe(input.cooldown);
        expect(rule.createdAt).toBeDefined();
        expect(rule.updatedAt).toBeDefined();
      });

      it('should create a disabled rule when specified', async () => {
        const input = createTestRule({ enabled: false });
        const rule = await alertManager.createRule(input);

        expect(rule.enabled).toBe(false);
      });

      it('should store the rule in cache', async () => {
        const input = createTestRule();
        const rule = await alertManager.createRule(input);

        const retrieved = alertManager.getRule(rule.id);
        expect(retrieved).toEqual(rule);
      });

      it('should support different severities', async () => {
        const severities: AlertSeverity[] = ['info', 'warning', 'critical'];

        for (const severity of severities) {
          const rule = await alertManager.createRule(createTestRule({ severity }));
          expect(rule.severity).toBe(severity);
        }
      });

      it('should support different metrics', async () => {
        const metrics: AlertMetric[] = [
          'latency_p95',
          'latency_p99',
          'latency_avg',
          'error_rate',
          'request_rate',
          'rate_limit_hits',
        ];

        for (const metric of metrics) {
          const rule = await alertManager.createRule(
            createTestRule({
              name: `Rule for ${metric}`,
              condition: { metric, operator: '>', threshold: 100, window: '5m' },
            })
          );
          expect(rule.condition.metric).toBe(metric);
        }
      });

      it('should support different operators', async () => {
        const operators: ComparisonOperator[] = ['>', '>=', '<', '<=', '==', '!='];

        for (const operator of operators) {
          const rule = await alertManager.createRule(
            createTestRule({
              name: `Rule with ${operator}`,
              condition: { metric: 'latency_p95', operator, threshold: 100, window: '5m' },
            })
          );
          expect(rule.condition.operator).toBe(operator);
        }
      });
    });

    describe('updateRule', () => {
      it('should update an existing rule', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const originalUpdatedAt = rule.updatedAt;

        // Small delay to ensure updatedAt changes
        await new Promise((resolve) => setTimeout(resolve, 10));

        const updated = await alertManager.updateRule(rule.id, {
          name: 'Updated Rule Name',
          severity: 'critical',
        });

        expect(updated).toBeDefined();
        expect(updated!.name).toBe('Updated Rule Name');
        expect(updated!.severity).toBe('critical');
        expect(updated!.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
      });

      it('should return null for non-existent rule', async () => {
        const result = await alertManager.updateRule('non-existent-id', { name: 'New Name' });
        expect(result).toBeNull();
      });

      it('should update condition partially', async () => {
        const rule = await alertManager.createRule(createTestRule());

        const updated = await alertManager.updateRule(rule.id, {
          condition: { ...rule.condition, threshold: 2000 },
        });

        expect(updated!.condition.threshold).toBe(2000);
        expect(updated!.condition.metric).toBe('latency_p95');
      });
    });

    describe('deleteRule', () => {
      it('should delete an existing rule', async () => {
        const rule = await alertManager.createRule(createTestRule());

        const deleted = await alertManager.deleteRule(rule.id);
        expect(deleted).toBe(true);

        const retrieved = alertManager.getRule(rule.id);
        expect(retrieved).toBeUndefined();
      });

      it('should return false for non-existent rule', async () => {
        const deleted = await alertManager.deleteRule('non-existent-id');
        expect(deleted).toBe(false);
      });
    });

    describe('getRules', () => {
      it('should return all rules', async () => {
        await alertManager.createRule(createTestRule({ name: 'Rule 1' }));
        await alertManager.createRule(createTestRule({ name: 'Rule 2' }));
        await alertManager.createRule(createTestRule({ name: 'Rule 3' }));

        const rules = alertManager.getRules();
        expect(rules).toHaveLength(3);
      });

      it('should return empty array when no rules exist', () => {
        const rules = alertManager.getRules();
        expect(rules).toEqual([]);
      });
    });

    describe('setRuleEnabled', () => {
      it('should enable a disabled rule', async () => {
        const rule = await alertManager.createRule(createTestRule({ enabled: false }));

        const success = await alertManager.setRuleEnabled(rule.id, true);
        expect(success).toBe(true);

        const updated = alertManager.getRule(rule.id);
        expect(updated!.enabled).toBe(true);
      });

      it('should disable an enabled rule', async () => {
        const rule = await alertManager.createRule(createTestRule({ enabled: true }));

        const success = await alertManager.setRuleEnabled(rule.id, false);
        expect(success).toBe(true);

        const updated = alertManager.getRule(rule.id);
        expect(updated!.enabled).toBe(false);
      });

      it('should return false for non-existent rule', async () => {
        const success = await alertManager.setRuleEnabled('non-existent-id', true);
        expect(success).toBe(false);
      });
    });
  });

  describe('Alert Triggering', () => {
    describe('trigger', () => {
      it('should create an active alert', async () => {
        const rule = await alertManager.createRule(createTestRule());

        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert message',
          value: 1500,
          threshold: 1000,
        });

        expect(alert).toBeDefined();
        expect(alert.id).toBeDefined();
        expect(alert.ruleId).toBe(rule.id);
        expect(alert.ruleName).toBe(rule.name);
        expect(alert.severity).toBe(rule.severity);
        expect(alert.status).toBe('active');
        expect(alert.message).toBe('Test alert message');
        expect(alert.value).toBe(1500);
        expect(alert.threshold).toBe(1000);
        expect(alert.triggeredAt).toBeDefined();
      });

      it('should store alert in active cache', async () => {
        const rule = await alertManager.createRule(createTestRule());

        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const retrieved = alertManager.getAlert(alert.id);
        expect(retrieved).toEqual(alert);
      });

      it('should include metadata when provided', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const metadata = { endpoint: '/api/test', backend: 'backend-1' };

        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
          metadata,
        });

        expect(alert.metadata).toEqual(metadata);
      });
    });

    describe('acknowledge', () => {
      it('should acknowledge an active alert', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const acknowledged = await alertManager.acknowledge(alert.id, 'test-user', 'Investigating');

        expect(acknowledged).toBeDefined();
        expect(acknowledged!.status).toBe('acknowledged');
        expect(acknowledged!.acknowledgedAt).toBeDefined();
        expect(acknowledged!.acknowledgedBy).toBe('test-user');
      });

      it('should return null for non-existent alert', async () => {
        const result = await alertManager.acknowledge('non-existent-id', 'test-user');
        expect(result).toBeNull();
      });

      it('should return null for already acknowledged alert', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        await alertManager.acknowledge(alert.id, 'user-1');
        const result = await alertManager.acknowledge(alert.id, 'user-2');

        expect(result).toBeNull();
      });
    });

    describe('resolve', () => {
      it('should resolve an active alert', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const resolved = await alertManager.resolve(alert.id, 'test-user', 'Issue fixed');

        expect(resolved).toBeDefined();
        expect(resolved!.status).toBe('resolved');
        expect(resolved!.resolvedAt).toBeDefined();
      });

      it('should remove alert from active cache', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        await alertManager.resolve(alert.id);

        const retrieved = alertManager.getAlert(alert.id);
        expect(retrieved).toBeUndefined();
      });

      it('should return null for non-existent alert', async () => {
        const result = await alertManager.resolve('non-existent-id');
        expect(result).toBeNull();
      });
    });

    describe('mute', () => {
      it('should mute an alert for specified duration', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const muted = await alertManager.mute(alert.id, '1h', 'test-user');

        expect(muted).toBeDefined();
        expect(muted!.status).toBe('muted');
        expect(muted!.mutedUntil).toBeDefined();
        expect(muted!.mutedUntil!.getTime()).toBeGreaterThan(Date.now());
      });

      it('should return null for non-existent alert', async () => {
        const result = await alertManager.mute('non-existent-id', '1h');
        expect(result).toBeNull();
      });
    });

    describe('unmute', () => {
      it('should unmute a muted alert', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        await alertManager.mute(alert.id, '1h');
        const unmuted = await alertManager.unmute(alert.id, 'test-user');

        expect(unmuted).toBeDefined();
        expect(unmuted!.status).toBe('active');
        expect(unmuted!.mutedUntil).toBeUndefined();
      });

      it('should return null for non-muted alert', async () => {
        const rule = await alertManager.createRule(createTestRule());
        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const result = await alertManager.unmute(alert.id);
        expect(result).toBeNull();
      });
    });
  });

  describe('Alert Queries', () => {
    describe('getActiveAlerts', () => {
      it('should return only active and acknowledged alerts', async () => {
        const rule = await alertManager.createRule(createTestRule());

        // Create alerts with different statuses
        const active = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Active alert',
          value: 1500,
          threshold: 1000,
        });

        const acknowledged = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Acknowledged alert',
          value: 1600,
          threshold: 1000,
        });
        await alertManager.acknowledge(acknowledged.id, 'user');

        const resolved = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Resolved alert',
          value: 1700,
          threshold: 1000,
        });
        await alertManager.resolve(resolved.id);

        const activeAlerts = alertManager.getActiveAlerts();

        expect(activeAlerts).toHaveLength(2);
        expect(activeAlerts.map((a) => a.id)).toContain(active.id);
        expect(activeAlerts.map((a) => a.id)).toContain(acknowledged.id);
      });
    });

    describe('getAlertsByStatus', () => {
      it('should filter alerts by status', async () => {
        const rule = await alertManager.createRule(createTestRule());

        await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Alert 1',
          value: 1500,
          threshold: 1000,
        });

        const alert2 = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Alert 2',
          value: 1600,
          threshold: 1000,
        });
        await alertManager.acknowledge(alert2.id, 'user');

        const activeAlerts = alertManager.getAlertsByStatus('active');
        const acknowledgedAlerts = alertManager.getAlertsByStatus('acknowledged');

        expect(activeAlerts).toHaveLength(1);
        expect(acknowledgedAlerts).toHaveLength(1);
      });
    });

    describe('getAlertsBySeverity', () => {
      it('should filter alerts by severity', async () => {
        const warningRule = await alertManager.createRule(
          createTestRule({ name: 'Warning Rule', severity: 'warning' })
        );
        const criticalRule = await alertManager.createRule(
          createTestRule({ name: 'Critical Rule', severity: 'critical' })
        );

        await alertManager.trigger({
          ruleId: warningRule.id,
          ruleName: warningRule.name,
          severity: warningRule.severity,
          message: 'Warning alert',
          value: 1500,
          threshold: 1000,
        });

        await alertManager.trigger({
          ruleId: criticalRule.id,
          ruleName: criticalRule.name,
          severity: criticalRule.severity,
          message: 'Critical alert',
          value: 1500,
          threshold: 1000,
        });

        const warningAlerts = alertManager.getAlertsBySeverity('warning');
        const criticalAlerts = alertManager.getAlertsBySeverity('critical');

        expect(warningAlerts).toHaveLength(1);
        expect(criticalAlerts).toHaveLength(1);
      });
    });
  });

  describe('Alert Statistics', () => {
    describe('getStats', () => {
      it('should return correct statistics', async () => {
        const warningRule = await alertManager.createRule(
          createTestRule({ name: 'Warning Rule', severity: 'warning' })
        );
        const criticalRule = await alertManager.createRule(
          createTestRule({ name: 'Critical Rule', severity: 'critical', enabled: false })
        );

        await alertManager.trigger({
          ruleId: warningRule.id,
          ruleName: warningRule.name,
          severity: warningRule.severity,
          message: 'Warning alert',
          value: 1500,
          threshold: 1000,
        });

        const alert2 = await alertManager.trigger({
          ruleId: criticalRule.id,
          ruleName: criticalRule.name,
          severity: criticalRule.severity,
          message: 'Critical alert',
          value: 1500,
          threshold: 1000,
        });
        await alertManager.acknowledge(alert2.id, 'user');

        const stats = alertManager.getStats();

        expect(stats.rulesCount).toBe(2);
        expect(stats.enabledRulesCount).toBe(1);
        expect(stats.activeAlertsCount).toBe(2); // active + acknowledged
        expect(stats.alertsByStatus.active).toBe(1);
        expect(stats.alertsByStatus.acknowledged).toBe(1);
        expect(stats.alertsBySeverity.warning).toBe(1);
        expect(stats.alertsBySeverity.critical).toBe(1);
      });

      it('should return zeros when no rules or alerts exist', () => {
        const stats = alertManager.getStats();

        expect(stats.rulesCount).toBe(0);
        expect(stats.enabledRulesCount).toBe(0);
        expect(stats.activeAlertsCount).toBe(0);
        expect(stats.alertsByStatus.active).toBe(0);
        expect(stats.alertsByStatus.acknowledged).toBe(0);
        expect(stats.alertsByStatus.resolved).toBe(0);
        expect(stats.alertsByStatus.muted).toBe(0);
      });
    });
  });

  describe('Condition Evaluation', () => {
    it('should evaluate > operator correctly', async () => {
      await alertManager.createRule(
        createTestRule({
          condition: { metric: 'latency_p95', operator: '>', threshold: 1000, window: '5m' },
        })
      );

      // Value above threshold - should trigger
      const mockFetcher = createMockMetricFetcher(1500);
      alertManager.setMetricFetcher(mockFetcher);
      await alertManager.checkAllRules();

      expect(alertManager.getActiveAlerts()).toHaveLength(1);
    });

    it('should evaluate < operator correctly', async () => {
      await alertManager.createRule(
        createTestRule({
          condition: { metric: 'request_rate', operator: '<', threshold: 100, window: '5m' },
        })
      );

      // Value below threshold - should trigger
      const mockFetcher = createMockMetricFetcher(50);
      alertManager.setMetricFetcher(mockFetcher);
      await alertManager.checkAllRules();

      expect(alertManager.getActiveAlerts()).toHaveLength(1);
    });

    it('should evaluate >= operator correctly', async () => {
      await alertManager.createRule(
        createTestRule({
          condition: { metric: 'latency_p95', operator: '>=', threshold: 1000, window: '5m' },
        })
      );

      // Value equal to threshold - should trigger
      const mockFetcher = createMockMetricFetcher(1000);
      alertManager.setMetricFetcher(mockFetcher);
      await alertManager.checkAllRules();

      expect(alertManager.getActiveAlerts()).toHaveLength(1);
    });

    it('should evaluate == operator correctly', async () => {
      await alertManager.createRule(
        createTestRule({
          condition: { metric: 'error_rate', operator: '==', threshold: 0, window: '5m' },
        })
      );

      const mockFetcher = createMockMetricFetcher(0);
      alertManager.setMetricFetcher(mockFetcher);
      await alertManager.checkAllRules();

      expect(alertManager.getActiveAlerts()).toHaveLength(1);
    });

    it('should not trigger when condition is not met', async () => {
      await alertManager.createRule(
        createTestRule({
          condition: { metric: 'latency_p95', operator: '>', threshold: 1000, window: '5m' },
        })
      );

      // Value below threshold - should not trigger
      const mockFetcher = createMockMetricFetcher(500);
      alertManager.setMetricFetcher(mockFetcher);
      await alertManager.checkAllRules();

      expect(alertManager.getActiveAlerts()).toHaveLength(0);
    });

    it('should not check disabled rules', async () => {
      await alertManager.createRule(
        createTestRule({
          enabled: false,
          condition: { metric: 'latency_p95', operator: '>', threshold: 1000, window: '5m' },
        })
      );

      const mockFetcher = createMockMetricFetcher(1500);
      alertManager.setMetricFetcher(mockFetcher);
      await alertManager.checkAllRules();

      expect(alertManager.getActiveAlerts()).toHaveLength(0);
    });
  });

  describe('Notification Channels', () => {
    describe('sendNotifications', () => {
      it('should send log notification successfully', async () => {
        const rule = await alertManager.createRule(
          createTestRule({
            actions: [{ type: 'log', config: {} }],
          })
        );

        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const results = await alertManager.sendNotifications(alert, rule.actions);

        expect(results).toHaveLength(1);
        expect(results[0]?.channel).toBe('log');
        expect(results[0]?.success).toBe(true);
      });

      it('should handle multiple notification channels', async () => {
        const rule = await alertManager.createRule(
          createTestRule({
            actions: [
              { type: 'log', config: {} },
              { type: 'log', config: {} }, // Using log twice for testing
            ],
          })
        );

        const alert = await alertManager.trigger({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: 'Test alert',
          value: 1500,
          threshold: 1000,
        });

        const results = await alertManager.sendNotifications(alert, rule.actions);

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.success)).toBe(true);
      });
    });
  });
});

describe('getAlertManager', () => {
  it('should return singleton instance', () => {
    const manager1 = getAlertManager();
    const manager2 = getAlertManager();

    expect(manager1).toBe(manager2);
  });
});
