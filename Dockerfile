FROM node:18-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY main.js ./
COPY css ./css
COPY images ./images
COPY *.html ./

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_TZ=Europe/Kyiv

EXPOSE 3000

CMD ["npm", "start"]
