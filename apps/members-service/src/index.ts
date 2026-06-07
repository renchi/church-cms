import Fastify from 'fastify'
import { prisma } from './infrastructure/prisma.js'

const app = Fastify({ logger: true })

app.get('/health', async () => {
  return { status: 'ok' }
})

const start = async () => {
  try {
    await prisma.$connect()
    await app.listen({ port: 3001, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

app.addHook('onClose', async () => {
  await prisma.$disconnect()
})

start()
