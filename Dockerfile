FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY backend/ ./backend/
COPY frontend/ ./frontend/

EXPOSE 3000

CMD ["node", "backend/server.js"]
