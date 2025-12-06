"""
AEGIS ML - Flask REST API Server

This module provides REST API endpoints for the ML service:
- /health - Health check endpoint
- /detect - Anomaly detection endpoint
- /detect/batch - Batch anomaly detection
- /optimize - Rate limit optimization
- /optimize/all - Optimize all endpoints
- /train - Train/retrain models
- /model/info - Get model information
- /export - Export training data

The API integrates with the main Node.js backend via HTTP.
"""

import logging
import os
import sys
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from models.anomaly_detector import (
    AnomalyDetector,
    RealTimeAnomalyDetector,
    TrafficMetrics,
)
from models.rate_limit_optimizer import (
    OptimizationStrategy,
    RateLimitOptimizer,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# =============================================================================
# Flask Application Setup
# =============================================================================

app = Flask(__name__)
CORS(app)

# Configuration from environment
app.config.update(
    DEBUG=os.getenv("FLASK_DEBUG", "false").lower() == "true",
    MODEL_PATH=os.getenv("MODEL_PATH", "./data/models"),
    DATA_PATH=os.getenv("DATA_PATH", "./data"),
    DB_HOST=os.getenv("POSTGRES_HOST", "localhost"),
    DB_PORT=int(os.getenv("POSTGRES_PORT", "5432")),
    DB_NAME=os.getenv("POSTGRES_DB", "aegis"),
    DB_USER=os.getenv("POSTGRES_USER", "aegis_user"),
    DB_PASSWORD=os.getenv("POSTGRES_PASSWORD", "dev_password"),
    ANOMALY_THRESHOLD=float(os.getenv("ANOMALY_THRESHOLD", "-0.5")),
    CONTAMINATION=float(os.getenv("CONTAMINATION", "0.1")),
)

# =============================================================================
# Global Model Instances
# =============================================================================

anomaly_detector: Optional[AnomalyDetector] = None
realtime_detector: Optional[RealTimeAnomalyDetector] = None
rate_optimizer: Optional[RateLimitOptimizer] = None


# =============================================================================
# Utility Functions
# =============================================================================


def get_db_connection():
    """Get database connection."""
    import psycopg2

    return psycopg2.connect(
        host=app.config["DB_HOST"],
        port=app.config["DB_PORT"],
        database=app.config["DB_NAME"],
        user=app.config["DB_USER"],
        password=app.config["DB_PASSWORD"],
    )


def load_training_data(days: int = 7) -> pd.DataFrame:
    """Load training data from database."""
    query = """
        SELECT
            date_trunc('minute', timestamp) as minute,
            COUNT(*) as total_requests,
            AVG(duration_ms) as avg_latency_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_latency_ms,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_latency_ms,
            COUNT(*) FILTER (WHERE status_code >= 400) as error_count,
            COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) as status_2xx,
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) as status_4xx,
            COUNT(*) FILTER (WHERE status_code >= 500) as status_5xx
        FROM request_metrics
        WHERE timestamp > NOW() - INTERVAL '%s days'
        GROUP BY minute
        ORDER BY minute
    """

    try:
        conn = get_db_connection()
        df = pd.read_sql_query(query % days, conn)
        conn.close()

        # Calculate derived metrics
        if not df.empty:
            df["requests_per_second"] = df["total_requests"] / 60.0
            df["error_rate"] = df["error_count"] / df["total_requests"].replace(0, 1)

        return df
    except Exception as e:
        logger.error(f"Failed to load training data: {e}")
        return pd.DataFrame()


def load_endpoint_data(days: int = 7) -> pd.DataFrame:
    """Load per-endpoint data for rate limit optimization."""
    query = """
        SELECT
            timestamp,
            path as endpoint,
            method,
            duration_ms as response_time_ms,
            status_code,
            user_id,
            ip_address
        FROM request_metrics
        WHERE timestamp > NOW() - INTERVAL '%s days'
        ORDER BY timestamp
    """

    try:
        conn = get_db_connection()
        df = pd.read_sql_query(query % days, conn)
        conn.close()
        return df
    except Exception as e:
        logger.error(f"Failed to load endpoint data: {e}")
        return pd.DataFrame()


def ensure_model_directory():
    """Ensure model directory exists."""
    Path(app.config["MODEL_PATH"]).mkdir(parents=True, exist_ok=True)


def require_trained_model(f):
    """Decorator to ensure model is trained before use."""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        global anomaly_detector
        if anomaly_detector is None or not anomaly_detector.is_trained:
            return (
                jsonify(
                    {
                        "error": True,
                        "message": "Model not trained. Call /train endpoint first.",
                    }
                ),
                400,
            )
        return f(*args, **kwargs)

    return decorated_function


def api_response(data: Any, success: bool = True, status: int = 200) -> tuple:
    """Standard API response format."""
    response = {
        "success": success,
        "data": data,
        "timestamp": datetime.utcnow().isoformat(),
    }
    return jsonify(response), status


def error_response(message: str, status: int = 400, details: Any = None) -> tuple:
    """Standard error response format."""
    response = {
        "success": False,
        "error": True,
        "message": message,
        "details": details,
        "timestamp": datetime.utcnow().isoformat(),
    }
    return jsonify(response), status


# =============================================================================
# Health Check Endpoint
# =============================================================================


@app.route("/health", methods=["GET"])
def health_check():
    """Health check endpoint."""
    global anomaly_detector, rate_optimizer

    status = {
        "status": "healthy",
        "service": "aegis-ml",
        "timestamp": datetime.utcnow().isoformat(),
        "models": {
            "anomaly_detector": {
                "loaded": anomaly_detector is not None,
                "trained": anomaly_detector.is_trained if anomaly_detector else False,
            },
            "rate_optimizer": {
                "loaded": rate_optimizer is not None,
                "trained": rate_optimizer.is_trained if rate_optimizer else False,
            },
        },
    }

    # Check database connectivity
    try:
        conn = get_db_connection()
        conn.close()
        status["database"] = "connected"
    except Exception as e:
        status["database"] = f"error: {str(e)}"
        status["status"] = "degraded"

    return api_response(status)


# =============================================================================
# Anomaly Detection Endpoints
# =============================================================================


@app.route("/detect", methods=["POST"])
@require_trained_model
def detect_anomaly():
    """
    Detect if given metrics represent an anomaly.

    Request body:
    {
        "requests_per_second": 100,
        "avg_latency_ms": 50,
        "p95_latency_ms": 100,
        "p99_latency_ms": 150,
        "error_rate": 0.01,
        "timestamp": "2024-01-15T10:00:00Z"  // optional
    }

    Response:
    {
        "success": true,
        "data": {
            "anomaly": true/false,
            "score": -0.5,
            "normalized_score": 0.7,
            "anomaly_type": "traffic_spike",
            "severity": "high",
            "confidence": 0.85,
            "explanation": "..."
        }
    }
    """
    global anomaly_detector, realtime_detector

    try:
        data = request.get_json()

        if not data:
            return error_response("Request body is required")

        # Use realtime detector if available for trend analysis
        if realtime_detector:
            result = realtime_detector.process(data)
        else:
            result = anomaly_detector.detect(data)

        return api_response(
            {
                "anomaly": result.is_anomaly,
                "score": result.score,
                "normalized_score": result.normalized_score,
                "anomaly_type": result.anomaly_type.value
                if result.anomaly_type
                else None,
                "severity": result.severity.value if result.severity else None,
                "confidence": result.confidence,
                "explanation": result.explanation,
                "features": result.features,
                "timestamp": result.timestamp.isoformat(),
            }
        )

    except Exception as e:
        logger.error(f"Detection error: {e}")
        return error_response(f"Detection failed: {str(e)}", 500)


@app.route("/detect/batch", methods=["POST"])
@require_trained_model
def detect_batch():
    """
    Detect anomalies in a batch of metrics.

    Request body:
    {
        "metrics": [
            {"requests_per_second": 100, "avg_latency_ms": 50, ...},
            {"requests_per_second": 150, "avg_latency_ms": 75, ...}
        ]
    }

    Response:
    {
        "success": true,
        "data": {
            "results": [...],
            "summary": {
                "total": 10,
                "anomalies": 2,
                "anomaly_rate": 0.2
            }
        }
    }
    """
    global anomaly_detector

    try:
        data = request.get_json()

        if not data or "metrics" not in data:
            return error_response("Request body with 'metrics' array is required")

        metrics_list = data["metrics"]
        results = anomaly_detector.detect_batch(metrics_list)

        # Convert results
        result_dicts = [r.to_dict() for r in results]
        anomaly_count = sum(1 for r in results if r.is_anomaly)

        return api_response(
            {
                "results": result_dicts,
                "summary": {
                    "total": len(results),
                    "anomalies": anomaly_count,
                    "anomaly_rate": anomaly_count / len(results) if results else 0,
                },
            }
        )

    except Exception as e:
        logger.error(f"Batch detection error: {e}")
        return error_response(f"Batch detection failed: {str(e)}", 500)


@app.route("/detect/trend", methods=["GET"])
@require_trained_model
def get_trend():
    """
    Get current trend analysis from realtime detector.

    Response:
    {
        "success": true,
        "data": {
            "window_size": 60,
            "anomaly_streak": 3,
            "rps_trend": "increasing",
            "latency_trend": "stable",
            "error_trend": "stable"
        }
    }
    """
    global realtime_detector

    if not realtime_detector:
        return error_response("Realtime detector not initialized")

    try:
        trend = realtime_detector.get_trend()
        return api_response(trend)
    except Exception as e:
        logger.error(f"Trend analysis error: {e}")
        return error_response(f"Trend analysis failed: {str(e)}", 500)


# =============================================================================
# Rate Limit Optimization Endpoints
# =============================================================================


@app.route("/optimize", methods=["POST"])
def optimize_rate_limit():
    """
    Get rate limit recommendation for an endpoint.

    Request body:
    {
        "endpoint": "/api/users",
        "tier": "default",
        "current_limit": 100,
        "strategy": "balanced"  // optional: conservative, balanced, permissive, adaptive
    }

    Response:
    {
        "success": true,
        "data": {
            "endpoint": "/api/users",
            "tier": "default",
            "recommended_limit": 150,
            "recommended_burst": 25,
            "confidence": 0.85,
            "reasoning": "..."
        }
    }
    """
    global rate_optimizer

    try:
        data = request.get_json()

        if not data or "endpoint" not in data:
            return error_response("Request body with 'endpoint' is required")

        # Initialize optimizer if needed
        if rate_optimizer is None:
            rate_optimizer = RateLimitOptimizer()

        # Parse strategy
        strategy = None
        if "strategy" in data:
            try:
                strategy = OptimizationStrategy(data["strategy"])
            except ValueError:
                return error_response(
                    f"Invalid strategy. Must be one of: {[s.value for s in OptimizationStrategy]}"
                )

        recommendation = rate_optimizer.recommend(
            endpoint=data["endpoint"],
            tier=data.get("tier", "default"),
            current_limit=data.get("current_limit"),
            strategy=strategy,
        )

        return api_response(recommendation.to_dict())

    except Exception as e:
        logger.error(f"Optimization error: {e}")
        return error_response(f"Optimization failed: {str(e)}", 500)


@app.route("/optimize/all", methods=["POST"])
def optimize_all_endpoints():
    """
    Get rate limit recommendations for all profiled endpoints.

    Request body:
    {
        "tier": "default",
        "strategy": "balanced"  // optional
    }

    Response:
    {
        "success": true,
        "data": {
            "recommendations": [...],
            "summary": {
                "total_endpoints": 10,
                "avg_confidence": 0.75
            }
        }
    }
    """
    global rate_optimizer

    try:
        data = request.get_json() or {}

        if rate_optimizer is None or not rate_optimizer.is_trained:
            return error_response(
                "Rate optimizer not trained. Call /train endpoint first."
            )

        # Parse strategy
        strategy = None
        if "strategy" in data:
            try:
                strategy = OptimizationStrategy(data["strategy"])
            except ValueError:
                pass

        recommendations = rate_optimizer.recommend_all(
            tier=data.get("tier", "default"),
            strategy=strategy,
        )

        recommendation_dicts = [r.to_dict() for r in recommendations]
        avg_confidence = (
            sum(r.confidence for r in recommendations) / len(recommendations)
            if recommendations
            else 0
        )

        return api_response(
            {
                "recommendations": recommendation_dicts,
                "summary": {
                    "total_endpoints": len(recommendations),
                    "avg_confidence": avg_confidence,
                },
            }
        )

    except Exception as e:
        logger.error(f"Batch optimization error: {e}")
        return error_response(f"Batch optimization failed: {str(e)}", 500)


@app.route("/optimize/clusters", methods=["GET"])
def get_endpoint_clusters():
    """
    Get endpoint clusters for group-based rate limiting.

    Query params:
    - n_clusters: Number of clusters (default: 5)

    Response:
    {
        "success": true,
        "data": {
            "clusters": {
                "high_traffic_fast": ["/api/health", "/api/status"],
                "medium_traffic": ["/api/users", "/api/orders"]
            }
        }
    }
    """
    global rate_optimizer

    if rate_optimizer is None or not rate_optimizer.is_trained:
        return error_response("Rate optimizer not trained. Call /train endpoint first.")

    try:
        n_clusters = int(request.args.get("n_clusters", 5))
        clusters = rate_optimizer.cluster_endpoints(n_clusters)
        return api_response({"clusters": clusters})
    except Exception as e:
        logger.error(f"Clustering error: {e}")
        return error_response(f"Clustering failed: {str(e)}", 500)


# =============================================================================
# Training Endpoints
# =============================================================================


@app.route("/train", methods=["POST"])
def train_models():
    """
    Train or retrain ML models on historical data.

    Request body (optional):
    {
        "days": 7,  // Number of days of data to use
        "contamination": 0.1,  // Expected anomaly rate
        "models": ["anomaly", "optimizer"]  // Which models to train
    }

    Response:
    {
        "success": true,
        "data": {
            "anomaly_detector": {
                "trained": true,
                "samples": 10000,
                "timestamp": "..."
            },
            "rate_optimizer": {
                "trained": true,
                "endpoints": 25,
                "timestamp": "..."
            }
        }
    }
    """
    global anomaly_detector, realtime_detector, rate_optimizer

    try:
        data = request.get_json() or {}
        days = data.get("days", 7)
        contamination = data.get("contamination", app.config["CONTAMINATION"])
        models_to_train = data.get("models", ["anomaly", "optimizer"])

        results = {}
        ensure_model_directory()

        # Train anomaly detector
        if "anomaly" in models_to_train:
            logger.info(f"Training anomaly detector on {days} days of data...")

            # Load data
            df = load_training_data(days)

            if df.empty or len(df) < 10:
                results["anomaly_detector"] = {
                    "trained": False,
                    "error": "Insufficient training data",
                    "samples": len(df),
                }
            else:
                # Create and train model
                anomaly_detector = AnomalyDetector(contamination=contamination)
                training_summary = anomaly_detector.train(df)

                # Initialize realtime detector
                realtime_detector = RealTimeAnomalyDetector(anomaly_detector)

                # Save model
                model_path = Path(app.config["MODEL_PATH"]) / "anomaly_detector"
                anomaly_detector.save(model_path)

                results["anomaly_detector"] = {
                    "trained": True,
                    "samples": training_summary["samples"],
                    "score_threshold": training_summary["score_threshold"],
                    "timestamp": training_summary["timestamp"],
                }

        # Train rate optimizer
        if "optimizer" in models_to_train:
            logger.info(f"Training rate optimizer on {days} days of data...")

            # Load endpoint data
            df = load_endpoint_data(days)

            if df.empty or len(df) < 10:
                results["rate_optimizer"] = {
                    "trained": False,
                    "error": "Insufficient training data",
                    "samples": len(df),
                }
            else:
                # Create and train optimizer
                rate_optimizer = RateLimitOptimizer()
                profiles = rate_optimizer.analyze_traffic(df)

                # Save optimizer
                optimizer_path = Path(app.config["MODEL_PATH"]) / "rate_optimizer"
                rate_optimizer.save(optimizer_path)

                results["rate_optimizer"] = {
                    "trained": True,
                    "endpoints": len(profiles),
                    "timestamp": rate_optimizer.training_timestamp.isoformat()
                    if rate_optimizer.training_timestamp
                    else None,
                }

        return api_response(results)

    except Exception as e:
        logger.error(f"Training error: {e}")
        return error_response(f"Training failed: {str(e)}", 500)


@app.route("/train/status", methods=["GET"])
def training_status():
    """
    Get training status of all models.

    Response:
    {
        "success": true,
        "data": {
            "anomaly_detector": {...},
            "rate_optimizer": {...}
        }
    }
    """
    global anomaly_detector, rate_optimizer

    status = {
        "anomaly_detector": (
            anomaly_detector.get_model_info() if anomaly_detector else {"loaded": False}
        ),
        "rate_optimizer": (
            rate_optimizer.get_optimizer_info() if rate_optimizer else {"loaded": False}
        ),
    }

    return api_response(status)


# =============================================================================
# Model Management Endpoints
# =============================================================================


@app.route("/model/info", methods=["GET"])
def get_model_info():
    """
    Get information about loaded models.

    Response:
    {
        "success": true,
        "data": {
            "anomaly_detector": {...},
            "rate_optimizer": {...}
        }
    }
    """
    global anomaly_detector, rate_optimizer

    info = {
        "anomaly_detector": (
            anomaly_detector.get_model_info() if anomaly_detector else None
        ),
        "rate_optimizer": (
            rate_optimizer.get_optimizer_info() if rate_optimizer else None
        ),
    }

    return api_response(info)


@app.route("/model/load", methods=["POST"])
def load_models():
    """
    Load pre-trained models from disk.

    Request body (optional):
    {
        "models": ["anomaly", "optimizer"]
    }

    Response:
    {
        "success": true,
        "data": {
            "anomaly_detector": {"loaded": true},
            "rate_optimizer": {"loaded": true}
        }
    }
    """
    global anomaly_detector, realtime_detector, rate_optimizer

    try:
        data = request.get_json() or {}
        models_to_load = data.get("models", ["anomaly", "optimizer"])

        results = {}

        # Load anomaly detector
        if "anomaly" in models_to_load:
            model_path = Path(app.config["MODEL_PATH"]) / "anomaly_detector"
            if model_path.exists():
                anomaly_detector = AnomalyDetector.load(model_path)
                realtime_detector = RealTimeAnomalyDetector(anomaly_detector)
                results["anomaly_detector"] = {
                    "loaded": True,
                    "trained": anomaly_detector.is_trained,
                }
            else:
                results["anomaly_detector"] = {
                    "loaded": False,
                    "error": "Model not found",
                }

        # Load rate optimizer
        if "optimizer" in models_to_load:
            optimizer_path = Path(app.config["MODEL_PATH"]) / "rate_optimizer"
            if optimizer_path.exists():
                rate_optimizer = RateLimitOptimizer.load(optimizer_path)
                results["rate_optimizer"] = {
                    "loaded": True,
                    "trained": rate_optimizer.is_trained,
                }
            else:
                results["rate_optimizer"] = {
                    "loaded": False,
                    "error": "Model not found",
                }

        return api_response(results)

    except Exception as e:
        logger.error(f"Model loading error: {e}")
        return error_response(f"Model loading failed: {str(e)}", 500)


@app.route("/model/reset", methods=["POST"])
def reset_models():
    """
    Reset models to untrained state.

    Response:
    {
        "success": true,
        "data": {"reset": true}
    }
    """
    global anomaly_detector, realtime_detector, rate_optimizer

    anomaly_detector = None
    realtime_detector = None
    rate_optimizer = None

    return api_response({"reset": True})


# =============================================================================
# Data Export Endpoints
# =============================================================================


@app.route("/export/training-data", methods=["GET"])
def export_training_data():
    """
    Export training data as CSV.

    Query params:
    - days: Number of days of data (default: 7)
    - format: csv or json (default: csv)

    Response:
    CSV file or JSON array
    """
    try:
        days = int(request.args.get("days", 7))
        format_type = request.args.get("format", "csv")

        df = load_training_data(days)

        if df.empty:
            return error_response("No training data available")

        if format_type == "json":
            return api_response(df.to_dict(orient="records"))
        else:
            csv_data = df.to_csv(index=False)
            return Response(
                csv_data,
                mimetype="text/csv",
                headers={
                    "Content-Disposition": "attachment;filename=training_data.csv"
                },
            )

    except Exception as e:
        logger.error(f"Export error: {e}")
        return error_response(f"Export failed: {str(e)}", 500)


@app.route("/export/endpoint-profiles", methods=["GET"])
def export_endpoint_profiles():
    """
    Export endpoint profiles as JSON.

    Response:
    {
        "success": true,
        "data": {
            "profiles": {...},
            "count": 25
        }
    }
    """
    global rate_optimizer

    if rate_optimizer is None or not rate_optimizer.is_trained:
        return error_response("Rate optimizer not trained")

    profiles = {k: v.to_dict() for k, v in rate_optimizer.endpoint_profiles.items()}

    return api_response({"profiles": profiles, "count": len(profiles)})


# =============================================================================
# Synthetic Data Generation (for testing)
# =============================================================================


@app.route("/generate/synthetic", methods=["POST"])
def generate_synthetic_data():
    """
    Generate synthetic training data for testing.

    Request body:
    {
        "duration_hours": 168,  // 7 days
        "base_rps": 50,
        "include_anomalies": true,
        "anomaly_rate": 0.05
    }

    Response:
    {
        "success": true,
        "data": {
            "generated": true,
            "samples": 10080,
            "anomalies_injected": 504
        }
    }
    """
    try:
        data = request.get_json() or {}
        duration_hours = data.get("duration_hours", 168)
        base_rps = data.get("base_rps", 50)
        include_anomalies = data.get("include_anomalies", True)
        anomaly_rate = data.get("anomaly_rate", 0.05)

        # Generate synthetic metrics
        samples = duration_hours * 60  # One sample per minute
        timestamps = pd.date_range(
            end=datetime.utcnow(),
            periods=samples,
            freq="1min",
        )

        # Base traffic with daily pattern
        np.random.seed(42)
        hours = np.array([t.hour for t in timestamps])
        daily_pattern = 0.5 + 0.5 * np.sin((hours - 6) * np.pi / 12)

        rps = base_rps * daily_pattern + np.random.normal(0, base_rps * 0.1, samples)
        latency = 50 + np.random.exponential(20, samples)
        error_rate = np.clip(np.random.normal(0.02, 0.01, samples), 0, 1)

        # Inject anomalies
        anomalies_injected = 0
        if include_anomalies:
            n_anomalies = int(samples * anomaly_rate)
            anomaly_indices = np.random.choice(samples, n_anomalies, replace=False)

            for idx in anomaly_indices:
                anomaly_type = np.random.choice(["spike", "latency", "error"])
                if anomaly_type == "spike":
                    rps[idx] *= np.random.uniform(3, 10)
                elif anomaly_type == "latency":
                    latency[idx] *= np.random.uniform(5, 20)
                else:
                    error_rate[idx] = np.random.uniform(0.2, 0.5)

            anomalies_injected = n_anomalies

        # Create DataFrame
        df = pd.DataFrame(
            {
                "timestamp": timestamps,
                "requests_per_second": rps,
                "avg_latency_ms": latency,
                "p95_latency_ms": latency * 1.5,
                "p99_latency_ms": latency * 2,
                "error_rate": error_rate,
            }
        )

        # Save to data directory
        data_path = Path(app.config["DATA_PATH"])
        data_path.mkdir(parents=True, exist_ok=True)
        df.to_csv(data_path / "synthetic_training_data.csv", index=False)

        return api_response(
            {
                "generated": True,
                "samples": len(df),
                "anomalies_injected": anomalies_injected,
                "file": str(data_path / "synthetic_training_data.csv"),
            }
        )

    except Exception as e:
        logger.error(f"Synthetic data generation error: {e}")
        return error_response(f"Generation failed: {str(e)}", 500)


@app.route("/train/synthetic", methods=["POST"])
def train_on_synthetic():
    """
    Train models on synthetic data (for testing without database).

    Response:
    {
        "success": true,
        "data": {...}
    }
    """
    global anomaly_detector, realtime_detector

    try:
        data_path = Path(app.config["DATA_PATH"]) / "synthetic_training_data.csv"

        if not data_path.exists():
            return error_response(
                "Synthetic data not found. Call /generate/synthetic first."
            )

        df = pd.read_csv(data_path)
        df["timestamp"] = pd.to_datetime(df["timestamp"])

        # Train anomaly detector
        anomaly_detector = AnomalyDetector(contamination=app.config["CONTAMINATION"])
        training_summary = anomaly_detector.train(df)

        # Initialize realtime detector
        realtime_detector = RealTimeAnomalyDetector(anomaly_detector)

        # Save model
        ensure_model_directory()
        model_path = Path(app.config["MODEL_PATH"]) / "anomaly_detector"
        anomaly_detector.save(model_path)

        return api_response(
            {
                "trained": True,
                "samples": training_summary["samples"],
                "score_threshold": training_summary["score_threshold"],
                "timestamp": training_summary["timestamp"],
            }
        )

    except Exception as e:
        logger.error(f"Training on synthetic data error: {e}")
        return error_response(f"Training failed: {str(e)}", 500)


# =============================================================================
# Error Handlers
# =============================================================================


@app.errorhandler(404)
def not_found(e):
    """Handle 404 errors."""
    return error_response("Endpoint not found", 404)


@app.errorhandler(500)
def server_error(e):
    """Handle 500 errors."""
    return error_response("Internal server error", 500)


# =============================================================================
# Application Startup
# =============================================================================


def initialize_app():
    """Initialize application state."""
    global anomaly_detector, realtime_detector, rate_optimizer

    logger.info("Initializing AEGIS ML Service...")

    # Try to load existing models
    model_path = Path(app.config["MODEL_PATH"])

    # Load anomaly detector
    anomaly_path = model_path / "anomaly_detector"
    if anomaly_path.exists():
        try:
            anomaly_detector = AnomalyDetector.load(anomaly_path)
            realtime_detector = RealTimeAnomalyDetector(anomaly_detector)
            logger.info("Loaded anomaly detector from disk")
        except Exception as e:
            logger.warning(f"Failed to load anomaly detector: {e}")

    # Load rate optimizer
    optimizer_path = model_path / "rate_optimizer"
    if optimizer_path.exists():
        try:
            rate_optimizer = RateLimitOptimizer.load(optimizer_path)
            logger.info("Loaded rate optimizer from disk")
        except Exception as e:
            logger.warning(f"Failed to load rate optimizer: {e}")

    logger.info("AEGIS ML Service initialized")


# Initialize on import
initialize_app()


# =============================================================================
# Main Entry Point
# =============================================================================


if __name__ == "__main__":
    port = int(os.getenv("ML_SERVICE_PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"

    logger.info(f"Starting AEGIS ML Service on port {port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
