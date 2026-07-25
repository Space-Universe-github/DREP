FROM node:20-alpine
WORKDIR /app

# better-sqlite3 needs to compile a native module
RUN apk add --no-cache python3 make g++

COPY package.json .
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 3001
CMD ["node", "index.js"]
