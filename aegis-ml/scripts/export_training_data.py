#!/usr/bin/env python3
"""
AEGIS ML - Training Data Export Script

This script exports historical metrics data from PostgreSQL for ML model training.
It supports multiple export formats and time ranges.

Usage:
    python export_training_data.py --days 7 --output training_data.csv
    python export_training_data.py --start 2024-01-01 --end 2024-01-07 --format json
    python export_training_data.py --days 30 --bucket 5m --output monthly_data.csv

Environment Variables:
    POSTGRES_HOST: Database host (default: localhost)
    POSTGRES_PORT: Database port (default: 5432)
    POSTGRES_DB: Database name (default: aegis)
    POSTGRES_USER: Database user (default: aegis_user)
    POSTGRES_PASSWORD: Database password (default: dev_password)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor

# =============================================================================
# Configuration
# =============================================================================

DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": int(os.getenv("POSTGRES_PORT", "5432")),
    "database": os.getenv("POSTGRES_DB", "aegis"),
    "user": os.getenv("POSTGRES_USER", "aegis_user"),
    "password": os.getenv("POSTGRES_PASSWORD", "dev_password"),
}

# Time bucket mapping
BUCKET_INTERVALS = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
    "6h": "6 hours",
    "1d": "1 day",
}


# =============================================================================
# Database Functions
# =============================================================================


def get_connection():
    """Get database connection."""
    return psycopg2.connect(**DB_CONFIG)


def export_aggregated_metrics(
    start_date: datetime,
    end_date: datetime,
    bucket: str = "1m",
) -> pd.DataFrame:
    """
    Export aggregated metrics suitable for anomaly detection training.

    Args:
        start_date: Start of time range
        end_date: End of time range
        bucket: Time bucket interval (1m, 5m, 15m, 1h, 6h, 1d)

    Returns:
        DataFrame with aggregated metrics
    """
    interval = BUCKET_INTERVALS.get(bucket, "1 minute")

    query = f"""
        SELECT
            date_trunc('minute', timestamp) -
                (EXTRACT(minute FROM timestamp)::integer %
                 EXTRACT(epoch FROM INTERVAL '{interval}')::integer / 60
                ) * interval '1 minute' as time_bucket,
            COUNT(*) as total_requests,
            AVG(response_time_ms)::numeric(10,2) as avg_latency_ms,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY response_time_ms)::numeric(10,2) as p50_latency_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::numeric(10,2) as p95_latency_ms,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms)::numeric(10,2) as p99_latency_ms,
            MIN(response_time_ms) as min_latency_ms,
            MAX(response_time_ms) as max_latency_ms,
            STDDEV(response_time_ms)::numeric(10,2) as stddev_latency_ms,
            COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) as status_2xx,
            COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) as status_3xx,
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) as status_4xx,
            COUNT(*) FILTER (WHERE status_code >= 500) as status_5xx,
            COUNT(DISTINCT ip_address) as unique_ips,
            COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) as unique_users
        FROM request_logs
        WHERE timestamp >= %s AND timestamp < %s
        GROUP BY time_bucket
        ORDER BY time_bucket
    """

    conn = get_connection()
    try:
        df = pd.read_sql_query(query, conn, params=(start_date, end_date))

        # Calculate derived metrics
        if not df.empty:
            # Requests per second (based on bucket size)
            bucket_seconds = get_bucket_seconds(bucket)
            df["requests_per_second"] = df["total_requests"] / bucket_seconds

            # Error rates
            df["error_count"] = df["status_4xx"] + df["status_5xx"]
            df["error_rate"] = df["error_count"] / df["total_requests"].replace(0, 1)
            df["client_error_rate"] = df["status_4xx"] / df["total_requests"].replace(
                0, 1
            )
            df["server_error_rate"] = df["status_5xx"] / df["total_requests"].replace(
                0, 1
            )

            # Success rate
            df["success_rate"] = df["status_2xx"] / df["total_requests"].replace(0, 1)

        return df
    finally:
        conn.close()


def export_endpoint_metrics(
    start_date: datetime,
    end_date: datetime,
) -> pd.DataFrame:
    """
    Export per-endpoint metrics for rate limit optimization.

    Args:
        start_date: Start of time range
        end_date: End of time range

    Returns:
        DataFrame with per-endpoint metrics
    """
    query = """
        SELECT
            timestamp,
            path as endpoint,
            method,
            response_time_ms,
            status_code,
            user_id,
            ip_address,
            backend_name,
            request_id
        FROM request_logs
        WHERE timestamp >= %s AND timestamp < %s
        ORDER BY timestamp
    """

    conn = get_connection()
    try:
        return pd.read_sql_query(query, conn, params=(start_date, end_date))
    finally:
        conn.close()


def export_endpoint_summary(
    start_date: datetime,
    end_date: datetime,
) -> pd.DataFrame:
    """
    Export endpoint-level summary statistics.

    Args:
        start_date: Start of time range
        end_date: End of time range

    Returns:
        DataFrame with endpoint summaries
    """
    query = """
        WITH endpoint_stats AS (
            SELECT
                path as endpoint,
                method,
                COUNT(*) as total_requests,
                AVG(response_time_ms)::numeric(10,2) as avg_latency_ms,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::numeric(10,2) as p95_latency_ms,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms)::numeric(10,2) as p99_latency_ms,
                COUNT(*) FILTER (WHERE status_code >= 400)::float / NULLIF(COUNT(*), 0) as error_rate,
                COUNT(DISTINCT ip_address) as unique_ips,
                COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) as unique_users,
                MIN(timestamp) as first_request,
                MAX(timestamp) as last_request
            FROM request_logs
            WHERE timestamp >= %s AND timestamp < %s
            GROUP BY path, method
        ),
        minute_stats AS (
            SELECT
                path as endpoint,
                method,
                date_trunc('minute', timestamp) as minute,
                COUNT(*) as requests_per_minute
            FROM request_logs
            WHERE timestamp >= %s AND timestamp < %s
            GROUP BY path, method, minute
        ),
        rpm_stats AS (
            SELECT
                endpoint,
                method,
                AVG(requests_per_minute)::numeric(10,2) as avg_rpm,
                MAX(requests_per_minute) as peak_rpm,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY requests_per_minute)::numeric(10,2) as p95_rpm,
                STDDEV(requests_per_minute)::numeric(10,2) as stddev_rpm
            FROM minute_stats
            GROUP BY endpoint, method
        )
        SELECT
            e.*,
            r.avg_rpm,
            r.peak_rpm,
            r.p95_rpm,
            r.stddev_rpm,
            EXTRACT(epoch FROM (e.last_request - e.first_request)) / 3600 as active_hours
        FROM endpoint_stats e
        LEFT JOIN rpm_stats r ON e.endpoint = r.endpoint AND e.method = r.method
        ORDER BY e.total_requests DESC
    """

    conn = get_connection()
    try:
        return pd.read_sql_query(
            query, conn, params=(start_date, end_date, start_date, end_date)
        )
    finally:
        conn.close()


def export_hourly_patterns(
    start_date: datetime,
    end_date: datetime,
) -> pd.DataFrame:
    """
    Export hourly traffic patterns for time-of-day analysis.

    Args:
        start_date: Start of time range
        end_date: End of time range

    Returns:
        DataFrame with hourly patterns
    """
    query = """
        SELECT
            EXTRACT(dow FROM timestamp) as day_of_week,
            EXTRACT(hour FROM timestamp) as hour_of_day,
            COUNT(*) as total_requests,
            AVG(response_time_ms)::numeric(10,2) as avg_latency_ms,
            COUNT(*) FILTER (WHERE status_code >= 400)::float / NULLIF(COUNT(*), 0) as error_rate
        FROM request_logs
        WHERE timestamp >= %s AND timestamp < %s
        GROUP BY day_of_week, hour_of_day
        ORDER BY day_of_week, hour_of_day
    """

    conn = get_connection()
    try:
        return pd.read_sql_query(query, conn, params=(start_date, end_date))
    finally:
        conn.close()


def get_data_stats(start_date: datetime, end_date: datetime) -> dict:
    """
    Get statistics about available data in the time range.

    Args:
        start_date: Start of time range
        end_date: End of time range

    Returns:
        Dictionary with data statistics
    """
    query = """
        SELECT
            COUNT(*) as total_records,
            MIN(timestamp) as earliest_record,
            MAX(timestamp) as latest_record,
            COUNT(DISTINCT path) as unique_endpoints,
            COUNT(DISTINCT ip_address) as unique_ips,
            COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) as unique_users
        FROM request_logs
        WHERE timestamp >= %s AND timestamp < %s
    """

    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(query, (start_date, end_date))
            result = cur.fetchone()
            return dict(result) if result else {}
    finally:
        conn.close()


# =============================================================================
# Utility Functions
# =============================================================================


def get_bucket_seconds(bucket: str) -> int:
    """Convert bucket string to seconds."""
    bucket_seconds = {
        "1m": 60,
        "5m": 300,
        "15m": 900,
        "1h": 3600,
        "6h": 21600,
        "1d": 86400,
    }
    return bucket_seconds.get(bucket, 60)


def save_dataframe(df: pd.DataFrame, output_path: str, format_type: str) -> None:
    """
    Save DataFrame to file in specified format.

    Args:
        df: DataFrame to save
        output_path: Output file path
        format_type: Output format (csv, json, parquet)
    """
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if format_type == "csv":
        df.to_csv(path, index=False)
    elif format_type == "json":
        df.to_json(path, orient="records", date_format="iso", indent=2)
    elif format_type == "parquet":
        df.to_parquet(path, index=False)
    else:
        raise ValueError(f"Unknown format: {format_type}")

    print(f"Saved {len(df)} records to {path}")


def parse_date(date_str: str) -> datetime:
    """Parse date string in various formats."""
    formats = [
        "%Y-%m-%d",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue

    raise ValueError(f"Could not parse date: {date_str}")


# =============================================================================
# CLI Interface
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Export AEGIS metrics data for ML training",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Export last 7 days of data
    python export_training_data.py --days 7 --output training_data.csv

    # Export specific date range
    python export_training_data.py --start 2024-01-01 --end 2024-01-07

    # Export with 5-minute buckets
    python export_training_data.py --days 7 --bucket 5m --output 5min_data.csv

    # Export endpoint summary
    python export_training_data.py --days 7 --type endpoint-summary --output endpoints.csv

    # Export as JSON
    python export_training_data.py --days 7 --format json --output data.json
        """,
    )

    # Time range arguments
    time_group = parser.add_mutually_exclusive_group()
    time_group.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of days of data to export (default: 7)",
    )
    time_group.add_argument(
        "--start",
        type=str,
        help="Start date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)",
    )

    parser.add_argument(
        "--end",
        type=str,
        help="End date (default: now)",
    )

    # Data type arguments
    parser.add_argument(
        "--type",
        type=str,
        choices=["aggregated", "endpoint", "endpoint-summary", "hourly"],
        default="aggregated",
        help="Type of data to export (default: aggregated)",
    )

    parser.add_argument(
        "--bucket",
        type=str,
        choices=["1m", "5m", "15m", "1h", "6h", "1d"],
        default="1m",
        help="Time bucket interval for aggregated data (default: 1m)",
    )

    # Output arguments
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        help="Output file path (default: stdout or auto-generated)",
    )

    parser.add_argument(
        "--format",
        "-f",
        type=str,
        choices=["csv", "json", "parquet"],
        default="csv",
        help="Output format (default: csv)",
    )

    # Database arguments
    parser.add_argument(
        "--db-host",
        type=str,
        help="Database host (overrides POSTGRES_HOST env var)",
    )
    parser.add_argument(
        "--db-port",
        type=int,
        help="Database port (overrides POSTGRES_PORT env var)",
    )
    parser.add_argument(
        "--db-name",
        type=str,
        help="Database name (overrides POSTGRES_DB env var)",
    )
    parser.add_argument(
        "--db-user",
        type=str,
        help="Database user (overrides POSTGRES_USER env var)",
    )
    parser.add_argument(
        "--db-password",
        type=str,
        help="Database password (overrides POSTGRES_PASSWORD env var)",
    )

    # Other arguments
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show data statistics before export",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be exported without actually exporting",
    )

    args = parser.parse_args()

    # Override database config from arguments
    if args.db_host:
        DB_CONFIG["host"] = args.db_host
    if args.db_port:
        DB_CONFIG["port"] = args.db_port
    if args.db_name:
        DB_CONFIG["database"] = args.db_name
    if args.db_user:
        DB_CONFIG["user"] = args.db_user
    if args.db_password:
        DB_CONFIG["password"] = args.db_password

    # Calculate time range
    if args.start:
        start_date = parse_date(args.start)
        end_date = parse_date(args.end) if args.end else datetime.utcnow()
    else:
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=args.days)

    print(f"Time range: {start_date} to {end_date}")
    print(f"Database: {DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['database']}")

    # Get and display stats
    if args.stats or args.dry_run:
        try:
            stats = get_data_stats(start_date, end_date)
            print("\nData Statistics:")
            print(f"  Total records: {stats.get('total_records', 0):,}")
            print(f"  Earliest record: {stats.get('earliest_record', 'N/A')}")
            print(f"  Latest record: {stats.get('latest_record', 'N/A')}")
            print(f"  Unique endpoints: {stats.get('unique_endpoints', 0):,}")
            print(f"  Unique IPs: {stats.get('unique_ips', 0):,}")
            print(f"  Unique users: {stats.get('unique_users', 0):,}")

            if stats.get("total_records", 0) == 0:
                print("\nNo data found in the specified time range.")
                sys.exit(1)
        except Exception as e:
            print(f"\nError getting statistics: {e}")
            sys.exit(1)

    if args.dry_run:
        print("\nDry run complete. No data exported.")
        sys.exit(0)

    # Export data
    try:
        print(f"\nExporting {args.type} data...")

        if args.type == "aggregated":
            df = export_aggregated_metrics(start_date, end_date, args.bucket)
        elif args.type == "endpoint":
            df = export_endpoint_metrics(start_date, end_date)
        elif args.type == "endpoint-summary":
            df = export_endpoint_summary(start_date, end_date)
        elif args.type == "hourly":
            df = export_hourly_patterns(start_date, end_date)
        else:
            raise ValueError(f"Unknown export type: {args.type}")

        if df.empty:
            print("No data found for the specified criteria.")
            sys.exit(1)

        print(f"Exported {len(df)} records")

        # Save or print output
        if args.output:
            save_dataframe(df, args.output, args.format)
        else:
            # Print to stdout
            if args.format == "csv":
                print("\n" + df.to_csv(index=False))
            elif args.format == "json":
                print("\n" + df.to_json(orient="records", date_format="iso", indent=2))
            else:
                # For parquet, we need a file
                output_path = f"training_data_{args.type}.parquet"
                save_dataframe(df, output_path, args.format)

    except psycopg2.Error as e:
        print(f"\nDatabase error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
