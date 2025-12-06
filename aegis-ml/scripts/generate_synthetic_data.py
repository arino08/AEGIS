#!/usr/bin/env python3
"""
AEGIS ML - Synthetic Data Generation Script

This script generates synthetic API traffic data for testing and development.
It simulates realistic traffic patterns including:
- Daily/weekly traffic patterns
- Traffic spikes and drops
- Latency variations
- Error rate anomalies
- Multiple endpoints with different characteristics

Usage:
    python generate_synthetic_data.py --days 7 --output training_data.csv
    python generate_synthetic_data.py --days 30 --anomaly-rate 0.05 --output data.csv
    python generate_synthetic_data.py --days 7 --insert-db

Environment Variables:
    POSTGRES_HOST: Database host (default: localhost)
    POSTGRES_PORT: Database port (default: 5432)
    POSTGRES_DB: Database name (default: aegis)
    POSTGRES_USER: Database user (default: aegis_user)
    POSTGRES_PASSWORD: Database password (default: dev_password)
"""

import argparse
import os
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

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

# Endpoint configurations with different traffic characteristics
ENDPOINT_CONFIGS = [
    {
        "path": "/api/health",
        "method": "GET",
        "base_rpm": 100,
        "base_latency_ms": 5,
        "latency_std": 2,
        "error_rate": 0.001,
        "weight": 0.15,
    },
    {
        "path": "/api/users",
        "method": "GET",
        "base_rpm": 50,
        "base_latency_ms": 50,
        "latency_std": 20,
        "error_rate": 0.02,
        "weight": 0.20,
    },
    {
        "path": "/api/users",
        "method": "POST",
        "base_rpm": 10,
        "base_latency_ms": 100,
        "latency_std": 40,
        "error_rate": 0.05,
        "weight": 0.05,
    },
    {
        "path": "/api/orders",
        "method": "GET",
        "base_rpm": 30,
        "base_latency_ms": 80,
        "latency_std": 30,
        "error_rate": 0.03,
        "weight": 0.15,
    },
    {
        "path": "/api/orders",
        "method": "POST",
        "base_rpm": 15,
        "base_latency_ms": 150,
        "latency_std": 50,
        "error_rate": 0.04,
        "weight": 0.10,
    },
    {
        "path": "/api/products",
        "method": "GET",
        "base_rpm": 40,
        "base_latency_ms": 60,
        "latency_std": 25,
        "error_rate": 0.02,
        "weight": 0.15,
    },
    {
        "path": "/api/auth/login",
        "method": "POST",
        "base_rpm": 20,
        "base_latency_ms": 200,
        "latency_std": 80,
        "error_rate": 0.10,
        "weight": 0.10,
    },
    {
        "path": "/api/search",
        "method": "GET",
        "base_rpm": 25,
        "base_latency_ms": 300,
        "latency_std": 100,
        "error_rate": 0.03,
        "weight": 0.10,
    },
]

# Backend configurations
BACKENDS = ["api-service-1", "api-service-2", "api-service-3"]

# User agent samples
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)",
    "Mozilla/5.0 (Android 11; Mobile) AppleWebKit/537.36",
    "python-requests/2.28.0",
    "curl/7.79.1",
    "PostmanRuntime/7.29.0",
]


# =============================================================================
# Traffic Pattern Functions
# =============================================================================


def daily_pattern(hour: int) -> float:
    """
    Generate daily traffic pattern multiplier.

    Simulates typical API traffic with:
    - Low traffic at night (00:00-06:00)
    - Ramp up in morning (06:00-09:00)
    - Peak during business hours (09:00-17:00)
    - Gradual decline in evening (17:00-23:00)
    """
    if 0 <= hour < 6:
        # Night: low traffic
        return 0.2 + 0.1 * np.sin((hour / 6) * np.pi)
    elif 6 <= hour < 9:
        # Morning ramp-up
        return 0.3 + 0.5 * ((hour - 6) / 3)
    elif 9 <= hour < 12:
        # Morning peak
        return 0.8 + 0.2 * np.sin(((hour - 9) / 3) * np.pi)
    elif 12 <= hour < 14:
        # Lunch dip
        return 0.85 + 0.1 * np.sin(((hour - 12) / 2) * np.pi)
    elif 14 <= hour < 17:
        # Afternoon peak
        return 0.9 + 0.1 * np.sin(((hour - 14) / 3) * np.pi)
    elif 17 <= hour < 20:
        # Evening decline
        return 0.9 - 0.4 * ((hour - 17) / 3)
    else:
        # Night transition
        return 0.5 - 0.3 * ((hour - 20) / 4)


def weekly_pattern(day_of_week: int) -> float:
    """
    Generate weekly traffic pattern multiplier.

    Day 0 = Monday, Day 6 = Sunday
    Business days have more traffic than weekends.
    """
    if day_of_week < 5:  # Weekday
        # Slight variation between weekdays
        weekday_factors = [0.95, 1.0, 1.0, 0.98, 0.90]
        return weekday_factors[day_of_week]
    else:  # Weekend
        return 0.4 if day_of_week == 5 else 0.3  # Saturday vs Sunday


def generate_traffic_multiplier(timestamp: datetime) -> float:
    """Generate combined traffic multiplier for a timestamp."""
    hour = timestamp.hour
    day_of_week = timestamp.weekday()

    daily = daily_pattern(hour)
    weekly = weekly_pattern(day_of_week)

    # Add some random noise
    noise = np.random.normal(1.0, 0.1)

    return max(0.1, daily * weekly * noise)


# =============================================================================
# Anomaly Generation Functions
# =============================================================================


class AnomalyGenerator:
    """Generate various types of anomalies in traffic data."""

    def __init__(self, anomaly_rate: float = 0.05, seed: int = 42):
        """
        Initialize anomaly generator.

        Args:
            anomaly_rate: Probability of any time window being anomalous
            seed: Random seed for reproducibility
        """
        self.anomaly_rate = anomaly_rate
        self.rng = np.random.default_rng(seed)
        self.anomaly_types = [
            "traffic_spike",
            "traffic_drop",
            "latency_spike",
            "error_spike",
            "sustained_load",
        ]

    def should_inject_anomaly(self) -> bool:
        """Determine if an anomaly should be injected."""
        return self.rng.random() < self.anomaly_rate

    def get_anomaly_type(self) -> str:
        """Get random anomaly type."""
        weights = [0.25, 0.15, 0.30, 0.20, 0.10]
        return self.rng.choice(self.anomaly_types, p=weights)

    def apply_traffic_spike(self, base_rpm: float) -> float:
        """Apply traffic spike anomaly."""
        multiplier = self.rng.uniform(3.0, 10.0)
        return base_rpm * multiplier

    def apply_traffic_drop(self, base_rpm: float) -> float:
        """Apply traffic drop anomaly."""
        multiplier = self.rng.uniform(0.05, 0.3)
        return base_rpm * multiplier

    def apply_latency_spike(self, base_latency: float) -> float:
        """Apply latency spike anomaly."""
        multiplier = self.rng.uniform(3.0, 20.0)
        return base_latency * multiplier

    def apply_error_spike(self, base_error_rate: float) -> float:
        """Apply error rate spike anomaly."""
        return min(0.8, base_error_rate + self.rng.uniform(0.15, 0.5))

    def apply_anomaly(
        self,
        anomaly_type: str,
        rpm: float,
        latency: float,
        error_rate: float,
    ) -> tuple[float, float, float, str]:
        """
        Apply specified anomaly type.

        Returns:
            Tuple of (modified_rpm, modified_latency, modified_error_rate, anomaly_label)
        """
        if anomaly_type == "traffic_spike":
            return self.apply_traffic_spike(rpm), latency, error_rate, "traffic_spike"
        elif anomaly_type == "traffic_drop":
            return self.apply_traffic_drop(rpm), latency, error_rate, "traffic_drop"
        elif anomaly_type == "latency_spike":
            return rpm, self.apply_latency_spike(latency), error_rate, "latency_spike"
        elif anomaly_type == "error_spike":
            return rpm, latency * 1.5, self.apply_error_spike(error_rate), "error_spike"
        elif anomaly_type == "sustained_load":
            # Multiple metrics affected
            return (
                rpm * self.rng.uniform(2.0, 4.0),
                latency * self.rng.uniform(1.5, 3.0),
                min(0.5, error_rate + self.rng.uniform(0.05, 0.15)),
                "sustained_load",
            )
        else:
            return rpm, latency, error_rate, "normal"


# =============================================================================
# Data Generation Functions
# =============================================================================


def generate_request_logs(
    start_date: datetime,
    end_date: datetime,
    base_rps: float = 50,
    anomaly_rate: float = 0.05,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate synthetic request log data.

    Args:
        start_date: Start of time range
        end_date: End of time range
        base_rps: Base requests per second
        anomaly_rate: Rate of anomaly injection
        seed: Random seed

    Returns:
        DataFrame with request log records
    """
    np.random.seed(seed)
    anomaly_gen = AnomalyGenerator(anomaly_rate, seed)

    records = []
    current_time = start_date

    # Pre-generate user IDs
    user_ids = [f"user_{i:04d}" for i in range(1000)]
    # Pre-generate IP addresses
    ip_addresses = [f"192.168.{i // 256}.{i % 256}" for i in range(500)]
    ip_addresses.extend([f"10.0.{i // 256}.{i % 256}" for i in range(500)])

    total_duration = (end_date - start_date).total_seconds()
    generated_seconds = 0
    last_progress = 0

    print(f"Generating data from {start_date} to {end_date}")

    while current_time < end_date:
        # Get traffic multiplier for this timestamp
        traffic_mult = generate_traffic_multiplier(current_time)

        # Calculate requests for this second
        effective_rps = base_rps * traffic_mult

        # Check for anomaly injection (per-minute granularity)
        is_anomaly = False
        anomaly_type = "normal"

        if current_time.second == 0 and anomaly_gen.should_inject_anomaly():
            is_anomaly = True
            anomaly_type = anomaly_gen.get_anomaly_type()

        # Generate requests for each endpoint
        for endpoint_config in ENDPOINT_CONFIGS:
            # Calculate endpoint-specific request count
            endpoint_weight = endpoint_config["weight"]
            endpoint_rps = effective_rps * endpoint_weight

            # Apply anomaly if applicable
            current_latency = endpoint_config["base_latency_ms"]
            current_error_rate = endpoint_config["error_rate"]

            if is_anomaly:
                endpoint_rps, current_latency, current_error_rate, _ = (
                    anomaly_gen.apply_anomaly(
                        anomaly_type,
                        endpoint_rps,
                        current_latency,
                        current_error_rate,
                    )
                )

            # Poisson distribution for request count
            request_count = np.random.poisson(endpoint_rps)

            for _ in range(request_count):
                # Generate request timestamp with sub-second precision
                request_time = current_time + timedelta(
                    microseconds=np.random.randint(0, 1000000)
                )

                # Generate latency (log-normal distribution)
                latency_mean = np.log(current_latency)
                latency_std = endpoint_config["latency_std"] / current_latency
                latency = np.random.lognormal(latency_mean, latency_std)
                latency = max(1, min(30000, latency))  # Clamp to reasonable range

                # Determine status code
                if np.random.random() < current_error_rate:
                    # Error response
                    if np.random.random() < 0.7:
                        status_code = np.random.choice([400, 401, 403, 404, 422])
                    else:
                        status_code = np.random.choice([500, 502, 503, 504])
                else:
                    # Success response
                    status_code = np.random.choice(
                        [200, 201, 204], p=[0.85, 0.10, 0.05]
                    )

                # Select random attributes
                user_id = (
                    np.random.choice(user_ids) if np.random.random() > 0.2 else None
                )
                ip_address = np.random.choice(ip_addresses)
                user_agent = np.random.choice(USER_AGENTS)
                backend = np.random.choice(BACKENDS)

                record = {
                    "timestamp": request_time,
                    "method": endpoint_config["method"],
                    "path": endpoint_config["path"],
                    "status_code": status_code,
                    "response_time_ms": int(latency),
                    "user_id": user_id,
                    "ip_address": ip_address,
                    "user_agent": user_agent,
                    "backend_name": backend,
                    "request_id": str(uuid.uuid4()),
                    "error_message": None if status_code < 400 else "Error occurred",
                    "anomaly_type": anomaly_type if is_anomaly else None,
                }
                records.append(record)

        # Move to next second
        current_time += timedelta(seconds=1)
        generated_seconds += 1

        # Progress indicator
        progress = int((generated_seconds / total_duration) * 100)
        if progress > last_progress and progress % 10 == 0:
            print(f"  Progress: {progress}%")
            last_progress = progress

    print(f"Generated {len(records):,} request records")

    return pd.DataFrame(records)


def generate_aggregated_metrics(
    start_date: datetime,
    end_date: datetime,
    bucket_minutes: int = 1,
    base_rps: float = 50,
    anomaly_rate: float = 0.05,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate synthetic aggregated metrics data.

    This is faster than generating individual requests and is suitable
    for training the anomaly detection model directly.

    Args:
        start_date: Start of time range
        end_date: End of time range
        bucket_minutes: Aggregation bucket size in minutes
        base_rps: Base requests per second
        anomaly_rate: Rate of anomaly injection
        seed: Random seed

    Returns:
        DataFrame with aggregated metrics
    """
    np.random.seed(seed)
    anomaly_gen = AnomalyGenerator(anomaly_rate, seed)

    records = []
    current_time = start_date

    total_buckets = int((end_date - start_date).total_seconds() / (bucket_minutes * 60))
    generated_buckets = 0

    print(f"Generating {total_buckets:,} aggregated metric buckets")

    while current_time < end_date:
        # Get traffic multiplier
        traffic_mult = generate_traffic_multiplier(current_time)

        # Base metrics for this bucket
        bucket_requests = base_rps * traffic_mult * 60 * bucket_minutes
        bucket_latency = 80  # Base average latency
        bucket_error_rate = 0.03  # Base error rate

        # Check for anomaly
        is_anomaly = anomaly_gen.should_inject_anomaly()
        anomaly_type = None

        if is_anomaly:
            anomaly_type = anomaly_gen.get_anomaly_type()
            bucket_requests, bucket_latency, bucket_error_rate, anomaly_type = (
                anomaly_gen.apply_anomaly(
                    anomaly_type,
                    bucket_requests,
                    bucket_latency,
                    bucket_error_rate,
                )
            )

        # Add noise
        bucket_requests = max(
            1, bucket_requests + np.random.normal(0, bucket_requests * 0.1)
        )
        bucket_latency = max(
            1, bucket_latency + np.random.normal(0, bucket_latency * 0.2)
        )

        # Calculate derived metrics
        requests_per_second = bucket_requests / (bucket_minutes * 60)

        # Generate percentiles (approximate)
        p50 = bucket_latency * 0.7
        p95 = bucket_latency * 1.8
        p99 = bucket_latency * 2.5

        # Status distribution
        total_requests = int(bucket_requests)
        error_requests = int(bucket_error_rate * total_requests)
        status_4xx = int(error_requests * 0.7)
        status_5xx = error_requests - status_4xx
        status_2xx = total_requests - error_requests

        record = {
            "time_bucket": current_time,
            "total_requests": total_requests,
            "requests_per_second": requests_per_second,
            "avg_latency_ms": bucket_latency,
            "p50_latency_ms": p50,
            "p95_latency_ms": p95,
            "p99_latency_ms": p99,
            "min_latency_ms": max(1, bucket_latency * 0.2),
            "max_latency_ms": bucket_latency * 4,
            "error_rate": bucket_error_rate,
            "status_2xx": status_2xx,
            "status_4xx": status_4xx,
            "status_5xx": status_5xx,
            "is_anomaly": is_anomaly,
            "anomaly_type": anomaly_type,
        }
        records.append(record)

        current_time += timedelta(minutes=bucket_minutes)
        generated_buckets += 1

        if generated_buckets % 1000 == 0:
            print(f"  Generated {generated_buckets:,} / {total_buckets:,} buckets")

    print(f"Generated {len(records):,} aggregated metric records")

    df = pd.DataFrame(records)

    # Summary
    anomaly_count = df["is_anomaly"].sum()
    print(
        f"  Anomalies injected: {anomaly_count} ({anomaly_count / len(df) * 100:.1f}%)"
    )

    return df


def insert_to_database(df: pd.DataFrame, table: str = "request_logs") -> int:
    """
    Insert generated data into PostgreSQL database.

    Args:
        df: DataFrame with request log data
        table: Target table name

    Returns:
        Number of records inserted
    """
    import psycopg2
    from psycopg2.extras import execute_values

    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()

    # Prepare data for insertion
    columns = [
        "timestamp",
        "method",
        "path",
        "status_code",
        "response_time_ms",
        "user_id",
        "ip_address",
        "user_agent",
        "backend_name",
        "request_id",
        "error_message",
    ]

    # Remove anomaly metadata columns if present
    insert_df = df[columns].copy()

    # Convert to list of tuples
    values = [tuple(row) for row in insert_df.itertuples(index=False)]

    # Batch insert
    batch_size = 5000
    total_inserted = 0

    print(f"Inserting {len(values):,} records into {table}...")

    for i in range(0, len(values), batch_size):
        batch = values[i : i + batch_size]

        query = f"""
            INSERT INTO {table} ({", ".join(columns)})
            VALUES %s
        """

        execute_values(cursor, query, batch)
        conn.commit()

        total_inserted += len(batch)
        print(f"  Inserted {total_inserted:,} / {len(values):,} records")

    cursor.close()
    conn.close()

    return total_inserted


# =============================================================================
# CLI Interface
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Generate synthetic API traffic data for ML training",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Generate 7 days of request logs
    python generate_synthetic_data.py --days 7 --output request_logs.csv

    # Generate aggregated metrics (faster)
    python generate_synthetic_data.py --days 7 --type aggregated --output metrics.csv

    # Generate with more anomalies
    python generate_synthetic_data.py --days 7 --anomaly-rate 0.1 --output data.csv

    # Insert directly into database
    python generate_synthetic_data.py --days 7 --insert-db

    # Generate high-traffic scenario
    python generate_synthetic_data.py --days 7 --base-rps 200 --output high_traffic.csv
        """,
    )

    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of days of data to generate (default: 7)",
    )

    parser.add_argument(
        "--type",
        type=str,
        choices=["requests", "aggregated"],
        default="requests",
        help="Type of data to generate (default: requests)",
    )

    parser.add_argument(
        "--bucket",
        type=int,
        default=1,
        help="Bucket size in minutes for aggregated data (default: 1)",
    )

    parser.add_argument(
        "--base-rps",
        type=float,
        default=50,
        help="Base requests per second (default: 50)",
    )

    parser.add_argument(
        "--anomaly-rate",
        type=float,
        default=0.05,
        help="Rate of anomaly injection (default: 0.05)",
    )

    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )

    parser.add_argument(
        "--output",
        "-o",
        type=str,
        help="Output file path (CSV)",
    )

    parser.add_argument(
        "--insert-db",
        action="store_true",
        help="Insert generated data into PostgreSQL database",
    )

    parser.add_argument(
        "--format",
        "-f",
        type=str,
        choices=["csv", "json", "parquet"],
        default="csv",
        help="Output format (default: csv)",
    )

    args = parser.parse_args()

    # Calculate time range
    end_date = datetime.utcnow()
    start_date = end_date - timedelta(days=args.days)

    print(f"Generating {args.days} days of synthetic data")
    print(f"Time range: {start_date} to {end_date}")
    print(f"Base RPS: {args.base_rps}")
    print(f"Anomaly rate: {args.anomaly_rate}")
    print()

    # Generate data
    if args.type == "requests":
        df = generate_request_logs(
            start_date,
            end_date,
            base_rps=args.base_rps,
            anomaly_rate=args.anomaly_rate,
            seed=args.seed,
        )
    else:
        df = generate_aggregated_metrics(
            start_date,
            end_date,
            bucket_minutes=args.bucket,
            base_rps=args.base_rps,
            anomaly_rate=args.anomaly_rate,
            seed=args.seed,
        )

    # Insert to database if requested
    if args.insert_db:
        if args.type != "requests":
            print("Warning: Only request logs can be inserted into database")
        else:
            try:
                inserted = insert_to_database(df)
                print(f"Successfully inserted {inserted:,} records into database")
            except Exception as e:
                print(f"Database insertion failed: {e}")
                sys.exit(1)

    # Save to file if output specified
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        if args.format == "csv":
            df.to_csv(output_path, index=False)
        elif args.format == "json":
            df.to_json(output_path, orient="records", date_format="iso", indent=2)
        elif args.format == "parquet":
            df.to_parquet(output_path, index=False)

        print(f"Saved {len(df):,} records to {output_path}")

    # Print summary
    print("\nData Summary:")
    print(f"  Total records: {len(df):,}")
    print(
        f"  Time range: {df['timestamp' if 'timestamp' in df.columns else 'time_bucket'].min()} to {df['timestamp' if 'timestamp' in df.columns else 'time_bucket'].max()}"
    )

    if "anomaly_type" in df.columns:
        anomaly_counts = df["anomaly_type"].value_counts(dropna=False)
        print(f"  Anomaly distribution:")
        for anomaly_type, count in anomaly_counts.items():
            label = anomaly_type if anomaly_type else "normal"
            print(f"    {label}: {count:,} ({count / len(df) * 100:.1f}%)")


if __name__ == "__main__":
    main()
