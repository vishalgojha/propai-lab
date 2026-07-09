FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY services/whatsmeow-ingestor/go.mod services/whatsmeow-ingestor/go.sum ./
RUN go mod download
COPY services/whatsmeow-ingestor/ .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /ingestor .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
ENV DATABASE_URL=postgres://postgres:Koolbunty%4012@db.jsoiuzfwohtfkctlkozw.supabase.co:5432/postgres?sslmode=require
COPY --from=builder /ingestor /ingestor
EXPOSE 3001
CMD ["/ingestor"]
