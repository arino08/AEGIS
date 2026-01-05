INSERT INTO aggregated_metrics (
  bucket, bucket_size, metric_name,
  endpoint, method, backend, status_class,
  count, sum_value, avg_value, min_value, max_value,
  p50_value, p95_value, p99_value
)
SELECT
  date_trunc('minute', timestamp) as bucket,
  '1m' as bucket_size,
  'request_duration' as metric_name,
  path as endpoint,
  method,
  backend,
  CASE
    WHEN status_code >= 500 THEN '5xx'
    WHEN status_code >= 400 THEN '4xx'
    WHEN status_code >= 300 THEN '3xx'
    ELSE '2xx'
  END as status_class,
  COUNT(*) as count,
  SUM(duration_ms) as sum_value,
  AVG(duration_ms) as avg_value,
  MIN(duration_ms) as min_value,
  MAX(duration_ms) as max_value,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) as p50_value,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_value,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_value
FROM request_metrics
WHERE timestamp >= NOW() - INTERVAL '60 minutes'
  AND timestamp < date_trunc('minute', NOW())
GROUP BY 1, 4, 5, 6, 7
ON CONFLICT (
        bucket,
        bucket_size,
        metric_name,
        COALESCE(endpoint, ''),
        COALESCE(method, ''),
        COALESCE(backend, ''),
        COALESCE(status_class, '')
)
DO UPDATE SET
  count = EXCLUDED.count,
  sum_value = EXCLUDED.sum_value,
  avg_value = EXCLUDED.avg_value,
  min_value = EXCLUDED.min_value,
  max_value = EXCLUDED.max_value,
  p50_value = EXCLUDED.p50_value,
  p95_value = EXCLUDED.p95_value,
  p99_value = EXCLUDED.p99_value;
