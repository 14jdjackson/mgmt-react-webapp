# MGMT — Raspberry Pi Docker image (Node/Express)
#
# Build context must be the BASE folder (not /dockerfiles), so Docker can
# reach both /src and /dockerfiles from a single context.
#
# Build and run via docker-compose (recommended):
#   docker compose up -d
#
# Or manually from the base folder:
#   docker build -f dockerfiles/Dockerfile -t mgmt .
#   docker run -d \
#     -p 3000:3000 \
#     -v /home/pi/mgmt/data:/app/data \
#     --restart unless-stopped \
#     --name mgmt \
#     mgmt
#
# The /app/data volume contains:
#   data/chores/daily.txt
#   data/chores/weekly.txt
#   data/chores/monthly.txt
#   data/config.json     ← calendar URL and admin PIN hash stored here

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (separate layer — only rebuilds if package.json changes)
COPY src/package.json .
RUN npm install --omit=dev

# Copy application files from /src
COPY src/server.js .
COPY src/static/ ./static/

# Create default data directory structure inside the image.
# These files are overridden at runtime by the mounted volume —
# they only exist as a fallback if no volume is mounted.
RUN mkdir -p /app/data/chores && \
    touch /app/data/chores/daily.txt \
          /app/data/chores/weekly.txt \
          /app/data/chores/monthly.txt && \
    echo '{"calendarUrl":"","adminPinHash":""}' > /app/data/config.json

ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
