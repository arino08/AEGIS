"""
AEGIS ML - API Package

This package provides the Flask REST API server for the ML service.
"""

from .flask_server import app, initialize_app

__all__ = ["app", "initialize_app"]
