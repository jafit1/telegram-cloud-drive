# Telegram Cloud Drive untuk Fly.io — Express + GramJS + sharp (tanpa browser)
FROM node:22-bookworm-slim

# sharp butuh libvips pada image berbasis Debian; sebagian disediakan prebuilt.
# ca-certificates untuk TLS ke Telegram.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# NODE_ENV di-set sebelum install supaya devDependencies (tailwind) tidak ikut.
ENV NODE_ENV=production
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Semua state (sesi Telegram, SQLite, cache, upload) hidup di volume /data.
ENV DATA_DIR=/data \
    PORT=3000 \
    NODE_OPTIONS=

RUN mkdir -p /data

EXPOSE 3000

# --localstorage-file harus menunjuk ke volume: Node membuka berkas ini sebelum
# kode apa pun jalan, jadi lokasinya tidak bisa ditentukan belakangan.
CMD ["node", "--localstorage-file=/data/gramjs-localstorage.json", "server.js"]
