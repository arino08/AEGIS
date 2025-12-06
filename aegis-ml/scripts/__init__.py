"""
AEGIS ML - Scripts Package

This package contains utility scripts for:
- Exporting training data from PostgreSQL
- Generating synthetic data for testing
- Model training and evaluation
"""

from .export_training_data import (
    export_aggregated_metrics,
    export_endpoint_metrics,
    export_endpoint_summary,
    export_hourly_patterns,
    get_data_stats,
)
from .generate_synthetic_data import (
    generate_aggregated_metrics,
    generate_request_logs,
    insert_to_database,
)

__all__ = [
    # Export functions
    "export_aggregated_metrics",
    "export_endpoint_metrics",
    "export_endpoint_summary",
    "export_hourly_patterns",
    "get_data_stats",
    # Generation functions
    "generate_request_logs",
    "generate_aggregated_metrics",
    "insert_to_database",
]
