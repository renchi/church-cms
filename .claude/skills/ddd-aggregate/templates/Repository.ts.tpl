import type { {{Aggregate}} } from './{{Aggregate}}.js'

// Port (interface) lives in the domain layer. The Prisma implementation lives in
// infrastructure/Prisma{{Aggregate}}Repository.ts — see reference/checklist.md.
export interface {{Aggregate}}Repository {
  findById(id: string): Promise<{{Aggregate}} | null>
  save({{aggregate}}: {{Aggregate}}): Promise<void>
}
