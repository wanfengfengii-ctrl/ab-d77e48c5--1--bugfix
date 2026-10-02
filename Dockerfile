# 藻类细胞分裂谱系复原 —— 无第三方运行时依赖，使用官方 Node 精简镜像
FROM node:22-alpine

WORKDIR /app

# 本项目无第三方运行时依赖（Node 内置 http / node:test），直接拷贝全部源码
COPY package.json ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

# 健康检查：命中网页服务自身的 /healthz
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
