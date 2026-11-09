import os
import socket
from datetime import datetime, timezone

from django.http import JsonResponse
from django.shortcuts import render


def index(request):
    return render(request, "index.html")


def hello(request):
    return JsonResponse(
        {
            "message": "Hello from Django, running on Floci EC2!",
            "service": "floci-cicd-demo",
            "environment": os.environ.get("APP_ENV", "dev"),
            "version": os.environ.get("APP_VERSION", "local"),
            "hostname": socket.gethostname(),
            "deployed_at": os.environ.get("DEPLOYED_AT", "unknown"),
            "server_time": datetime.now(timezone.utc).isoformat(),
            "stack": {
                "backend": "Django 5.2 + gunicorn",
                "frontend": "React + Vite",
                "platform": "Floci (local AWS emulator)",
            },
        }
    )


def healthz(request):
    return JsonResponse({"status": "ok"})
