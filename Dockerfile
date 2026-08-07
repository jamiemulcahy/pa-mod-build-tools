# The test environment. The suite is almost entirely about git's behaviour, so it runs against
# a pinned git and a pinned Node, with no host-level git config able to leak into it.
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

CMD ["node", "--test"]
