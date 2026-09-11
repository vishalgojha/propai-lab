FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY services/whatsmeow-ingestor/go.mod services/whatsmeow-ingestor/go.sum ./
RUN go mod download
COPY services/whatsmeow-ingestor/ .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /ingestor .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata curl
COPY --from=builder /ingestor /ingestor
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD curl -fsS http://127.0.0.1:3001/health || exit 1
CMD ["/ingestor"]
