FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/gmail-ingestor/main.py /app/main.py
CMD ["python", "/app/main.py"]
