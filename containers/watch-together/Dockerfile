FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg xvfb openbox x11vnc novnc websockify pulseaudio dbus-x11 \
    fonts-noto-cjk fonts-dejavu-core ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1001 torii && mkdir /opt/companion /tmp/runtime-torii \
    && chown torii:torii /opt/companion /tmp/runtime-torii
WORKDIR /opt/companion
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=torii:torii . .
USER torii
ENV DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/runtime-torii HOME=/home/torii
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bash", "/opt/companion/start.sh"]
