import * as fs from 'fs-jetpack'
import { introspectionQuery } from 'graphql'
import { createE2EContext } from 'nexus/dist/lib/e2e-testing'
import * as Path from 'path'
import { ConnectableObservable, Subscription } from 'rxjs'
import { refCount } from 'rxjs/operators'
import stripAnsi from 'strip-ansi'
import { bufferOutput, takeUntilServerListening } from './utils'

export async function e2eTestPlugin(
  ctx: ReturnType<typeof createE2EContext>,
  opts?: { withoutMigration?: boolean; withoutSeed?: boolean }
) {
  if (!opts?.withoutMigration) {
    console.log('Create migration file...')
    const dbMigrateSaveResult = await ctx
      .spawn(['yarn', 'prisma', 'migrate', 'save', '--create-db', '--name="init"', '--experimental'])
      .refCount()
      .pipe(bufferOutput)
      .toPromise()

    expect(stripAnsi(dbMigrateSaveResult)).toContain('Prisma Migrate just created your migration')

    console.log('Apply migration...')
    const dbMigrateUpResult = await ctx
      .spawn(['yarn', 'prisma', 'migrate', 'up', '--auto-approve', '--experimental'])
      .refCount()
      .pipe(bufferOutput)
      .toPromise()

    expect(stripAnsi(dbMigrateUpResult)).toContain('Done with 1 migration')
  }

  await ctx.spawn(['yarn', 'prisma', 'generate']).refCount().pipe(bufferOutput).toPromise()

  if (!opts?.withoutSeed) {
    const seedResult = await ctx
      .spawn(['yarn', '-s', 'ts-node', 'prisma/seed.ts'], { cwd: ctx.dir })
      .refCount()
      .pipe(bufferOutput)
      .toPromise()

    expect(seedResult).toContain('Seeded: ')
  }

  let proc: ConnectableObservable<string> = ctx.nexus(['dev'])
  let sub: Subscription = proc.connect()

  // Run nexus dev and query graphql api
  await proc.pipe(takeUntilServerListening).toPromise()

  // Wait some arbitrary time to make sure typegen has time to be persisted to the filesystem
  await new Promise((res) => setTimeout(res, 2000))

  const queryResult: { worlds: any[] } = await ctx.client.request(`{
    worlds {
      id
      name
      population
    }
  }`)

  expect(queryResult).toMatchSnapshot('worlds-query')

  const introspectionResult = await ctx.client.request(introspectionQuery)

  expect(introspectionResult).toMatchSnapshot('introspection')

  sub.unsubscribe()

  const nexusPrismaTypegenPath = Path.join(
    ctx.dir,
    'node_modules',
    '@types',
    'typegen-nexus-prisma',
    'index.d.ts'
  )

  // Assert that nexus-prisma typegen was created
  expect(fs.exists(nexusPrismaTypegenPath)).toStrictEqual('file')

  // Run nexus build
  const buildOutput = await ctx.nexus(['build']).pipe(refCount(), bufferOutput).toPromise()

  expect(buildOutput).toContain('success')
}
