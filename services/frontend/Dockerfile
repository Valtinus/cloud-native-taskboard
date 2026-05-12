FROM alpine:3.19 AS cert-gen
RUN apk add --no-cache openssl && \
    mkdir -p /certs && \
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout /certs/tls.key \
      -out    /certs/tls.crt \
      -days   365 \
      -subj   "/CN=taskboard/O=TaskBoard/C=HU"

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=cert-gen /certs /etc/nginx/certs
EXPOSE 80 443

