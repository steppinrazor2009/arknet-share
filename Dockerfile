FROM node:20-slim

# Install ffmpeg and build dependencies in one layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (verbose to catch errors)
RUN npm install 2>&1

# Clean npm cache
RUN npm cache clean --force

COPY server.js db.js setup.js ./
COPY public/ public/

EXPOSE 3000
CMD ["node", "server.js"]
