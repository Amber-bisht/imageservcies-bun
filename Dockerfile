# Use the official Bun image
FROM oven/bun:latest

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
RUN bun install --production

# Copy the rest of the application
COPY . .

# Ensure the upload directory exists
RUN mkdir -p public/images

# Expose the port the server runs on
EXPOSE 4000

# Set health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:4000/health || exit 1

# Start the server
CMD ["bun", "run", "start"]
