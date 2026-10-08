import { $ } from "bun"
import type { Check } from "./manifest.ts"
import { removeContainer, type Docker } from "./runner.ts"

export interface Database {
  readonly containers: ReadonlyArray<string>
  readonly host: { readonly url: string; readonly replicaUrl?: string }
  readonly network: { readonly url: string; readonly replicaUrl?: string }
}

const connection = (service: NonNullable<Check["postgres"]>, address: string) => {
  const user = service.env.POSTGRES_USER ?? "postgres"
  const password = service.env.POSTGRES_PASSWORD ?? ""
  const database = service.env.POSTGRES_DB ?? user
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${address}/${database}`
}

const published = async (docker: Docker, name: string) =>
  ((await $`docker port ${name} 5432/tcp`.env(docker.env).text()).trim().split("\n")[0] ?? "")
    .split(":")
    .pop() ?? ""

const waitReady = async (docker: Docker, name: string, replica: boolean) => {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (replica) {
      const ready = await $`docker exec ${name} pg_isready -h 127.0.0.1 -p 5432`
        .env(docker.env)
        .quiet()
        .nothrow()
      if (ready.exitCode === 0) return
    } else {
      const logs = await $`docker logs ${name}`.env(docker.env).quiet().nothrow()
      const text = logs.stdout.toString() + logs.stderr.toString()
      const initialized = text.indexOf("PostgreSQL init process complete")
      if (initialized !== -1 && text.lastIndexOf("ready to accept connections") > initialized)
        return
    }
    await Bun.sleep(1000)
  }
  throw new Error(`The Postgres server ${name} never became ready`)
}

/**
 * Like a GitHub service container, but private to one check or step: a container named for this
 * run on the network the caller created, reachable there as `postgres` and published on a free
 * loopback port, and optionally a streaming physical replica of it, reachable as `replica`. The
 * replica is what `.github/src/replica.ts` builds, but it lives on the private network instead of
 * the host's, so concurrent runs cannot meet and a sandboxed check needs no Docker access to get
 * one. Only containers this run created are ever removed, by exact name.
 */
export async function startDatabase(
  docker: Docker,
  name: string,
  network: string,
  service: NonNullable<Check["postgres"]>,
  withReplica: boolean,
): Promise<Database> {
  const envArgs = Object.entries(service.env).flatMap(([key, value]) => ["-e", `${key}=${value}`])
  docker.containers.push(name)
  await $`docker run -d --name ${name} --label akter.local-verify=1 --network ${network} --network-alias postgres -p 127.0.0.1::5432 ${envArgs} ${service.image} postgres ${service.args ?? []}`
    .env(docker.env)
    .quiet()
  await waitReady(docker, name, false)
  const hostPort = await published(docker, name)
  const containers = [name]
  if (!withReplica)
    return {
      containers,
      host: { url: connection(service, `127.0.0.1:${hostPort}`) },
      network: { url: connection(service, "postgres:5432") },
    }

  const user = service.env.POSTGRES_USER ?? "postgres"
  const replica = `${name}-replica`
  const slot = replica.replaceAll(/[^a-zA-Z0-9_]/g, "_").toLowerCase()
  await $`docker exec ${name} bash -c ${`grep -q '^host replication all all' "$PGDATA/pg_hba.conf" || echo 'host replication all all scram-sha-256' >> "$PGDATA/pg_hba.conf"`}`
    .env(docker.env)
    .quiet()
  await $`docker exec ${name} psql -U ${user} -d postgres -c ${"SELECT pg_reload_conf()"}`
    .env(docker.env)
    .quiet()
  docker.containers.push(replica)
  containers.push(replica)
  await $`docker run -d --name ${replica} --label akter.local-verify=1 --network ${network} --network-alias replica -p 127.0.0.1::5432 --user postgres -e PGPASSWORD=${service.env.POSTGRES_PASSWORD ?? ""} ${service.image} bash -c ${`pg_basebackup -h postgres -p 5432 -U ${user} -D /tmp/replica -R -X stream -C -S ${slot} && chmod 700 /tmp/replica && exec postgres -D /tmp/replica -c listen_addresses=*`}`
    .env(docker.env)
    .quiet()
  await waitReady(docker, replica, true)
  const replicaPort = await published(docker, replica)
  return {
    containers,
    host: {
      url: connection(service, `127.0.0.1:${hostPort}`),
      replicaUrl: connection(service, `127.0.0.1:${replicaPort}`),
    },
    network: {
      url: connection(service, "postgres:5432"),
      replicaUrl: connection(service, "replica:5432"),
    },
  }
}

export async function stopDatabase(docker: Docker, database: Database) {
  for (const name of [...database.containers].reverse()) await removeContainer(docker, name)
}
