import type Database from 'better-sqlite3'
import type { Auth, RateLimiter } from './auth.js'
import type { Generator, GenerationOptions } from './generate/index.js'

export interface Context extends GenerationOptions {
  db: Database.Database
  auth: Auth
  rate: RateLimiter
  generator: Generator
}
