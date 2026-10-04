import * as AWS from "alchemy/AWS"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Axiom from "alchemy/Axiom"
import * as Output from "alchemy/Output"
import * as Namespace from "alchemy/Namespace"
import { retain } from "alchemy/RemovalPolicy"
import { adopt } from "alchemy/AdoptPolicy"
import { Effect, Layer, Redacted } from "effect"
import { deployment } from "./config.ts"
import { network } from "./network.ts"
import { providers } from "./aws.ts"
import { controlTables } from "./placement.ts"
import { Neki } from "./neki/resources.ts"
import { providers as nekiProviders } from "./neki/providers.ts"

export const stackProviders = providers.pipe(
  Layer.provideMerge(Cloudflare.providers()),
  Layer.provideMerge(Axiom.providers()),
  Layer.provideMerge(nekiProviders),
)

export const resources = Effect.gen(function* () {
  const config = yield* deployment
  const stateBucket = yield* AWS.S3.Bucket("StateBucket", {
    bucketName: config.stateBucket,
    versioning: "Enabled",
    forceDestroy: false,
    objectOwnership: "BucketOwnerEnforced",
    encryption: { sseAlgorithm: "AES256", blockedEncryptionTypes: ["SSE-C"] },
    publicAccessBlock: {
      blockPublicAcls: true,
      ignorePublicAcls: true,
      blockPublicPolicy: true,
      restrictPublicBuckets: true,
    },
  }).pipe(adopt(true), retain())
  const { vpc, subnets, loadBalancer, servicesGroup, edgeGroup } = yield* network(config)
  const cluster = yield* AWS.ECS.Cluster("Cluster", {
    clusterName: config.name,
    capacityProviders: ["FARGATE", "FARGATE_SPOT"],
    defaultCapacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }],
  })
  const runnerGroup = yield* AWS.EC2.SecurityGroup("RunnerGroup", {
    vpcId: vpc.vpcId,
    ingress: [
      { ipProtocol: "tcp", fromPort: 8080, toPort: 8080, referencedGroupId: edgeGroup.groupId },
    ],
  })
  const runnerRepository = yield* AWS.ECR.Repository("RunnerBase", {
    repositoryName: "akter/runner-base",
    imageTagMutability: "IMMUTABLE",
    scanOnPush: true,
  })
  const customerKey = yield* AWS.KMS.Key("CustomerEnvironmentKey", {
    description: `Customer environment envelope encryption for ${config.name}`,
    enableKeyRotation: true,
    deletionWindow: "30 days",
  }).pipe(retain(config.stage === "prod"))
  const secretsKey = yield* AWS.KMS.Key("ServiceSecretsKey", {
    description: `Service secrets for ${config.name}`,
    enableKeyRotation: true,
    deletionWindow: "30 days",
  }).pipe(retain(config.stage === "prod"))
  const authSecret = yield* AWS.SecretsManager.Secret("AuthSecret", {
    name: `${config.name}/auth`,
    kmsKeyId: secretsKey.keyArn,
    generateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
  })
  const edgeSigningKeys = yield* AWS.SecretsManager.Secret("EdgeSigningKeys", {
    name: `${config.name}/edge-signing-keys`,
    kmsKeyId: secretsKey.keyArn,
  })
  const database = yield* Neki.Database("Database", {
    organization: config.planetscaleOrganization,
    name: config.name,
    region: config.region === "us-east-1" ? "us-east" : "us-west",
    clusterSize: config.nekiClusterSize,
    replicas: config.stage === "prod" ? 2 : 0,
    shardCount: config.nekiShardCount,
    routers: [
      {
        name: "default",
        size: config.nekiRouterSize,
        replicasPerCell: config.stage === "prod" ? 2 : 1,
      },
    ],
    unshardedTables: controlTables,
    deletionProtected: config.stage === "prod",
  }).pipe(retain(config.stage === "prod"))
  const databaseRole = yield* Neki.Role("RuntimeRole", {
    organization: config.planetscaleOrganization,
    database: database.name,
    branch: database.branch,
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  })
  const migrationRole = yield* Neki.Role("MigrationRole", {
    organization: config.planetscaleOrganization,
    database: database.name,
    branch: database.branch,
    inheritedRoles: ["postgres", "neki_viewer"],
  })
  const databaseSecret = yield* AWS.SecretsManager.Secret("DatabaseConnection", {
    name: `${config.name}/database`,
    kmsKeyId: secretsKey.keyArn,
    secretString: databaseRole.connectionUrl,
  })
  const dataset = yield* Axiom.Dataset("Traces", { name: `${config.name}-traces` })
  const logs = yield* Axiom.Dataset("Logs", { name: `${config.name}-logs` })
  const ingest = yield* Axiom.ApiToken("TelemetryIngest", {
    name: `${config.name}-ingest`,
    datasetCapabilities: Output.all(dataset.name, logs.name).pipe(
      Output.map(([traces, logs]) => ({
        [traces]: { ingest: ["create"] },
        [logs]: { ingest: ["create"] },
      })),
    ),
  })
  const telemetrySecret = yield* AWS.SecretsManager.Secret("TelemetryToken", {
    name: `${config.name}/axiom`,
    kmsKeyId: secretsKey.keyArn,
    secretString: ingest.token,
  })
  const traceHeaders = yield* AWS.SecretsManager.Secret("TraceHeaders", {
    name: `${config.name}/otel-traces`,
    kmsKeyId: secretsKey.keyArn,
    secretString: ingest.token.pipe(
      Output.map((token) =>
        Redacted.make(
          `Authorization=Bearer%20${Redacted.value(token)},x-axiom-dataset=${config.name}-traces`,
        ),
      ),
    ),
  })
  const logHeaders = yield* AWS.SecretsManager.Secret("LogHeaders", {
    name: `${config.name}/otel-logs`,
    kmsKeyId: secretsKey.keyArn,
    secretString: ingest.token.pipe(
      Output.map((token) =>
        Redacted.make(
          `Authorization=Bearer%20${Redacted.value(token)},x-axiom-dataset=${config.name}-logs`,
        ),
      ),
    ),
  })
  yield* Axiom.Monitor("ServiceErrors", {
    name: `${config.name}-errors`,
    type: "Threshold",
    aplQuery: dataset.name.pipe(
      Output.map((name) => `['${name}'] | where ['status.code'] == 'ERROR' | summarize count()`),
    ),
    operator: "Above",
    threshold: 0,
    intervalMinutes: 5,
    rangeMinutes: 5,
    alertOnNoData: false,
    resolvable: true,
    notifierIds: [config.notifierId],
  })
  const zone = yield* Cloudflare.Zone.Zone("Zone", { name: config.zone }).pipe(retain())
  yield* Cloudflare.Zone.Setting("StrictTls", {
    zoneId: zone.zoneId,
    settingId: "ssl",
    value: "strict",
  })
  const turnstile = yield* Cloudflare.Turnstile.Widget("Signup", {
    name: config.name,
    domains: [config.zone],
    mode: "managed",
  })
  const turnstileSecret = yield* AWS.SecretsManager.Secret("TurnstileSecret", {
    name: `${config.name}/turnstile`,
    kmsKeyId: secretsKey.keyArn,
    secretString: turnstile.secret,
  })
  const emailSet = yield* AWS.SES.ConfigurationSet("EmailConfiguration", {
    configurationSetName: config.name,
    tlsPolicy: "REQUIRE",
    suppressedReasons: ["BOUNCE", "COMPLAINT"],
  })
  const email = yield* AWS.SES.EmailIdentity("EmailIdentity", {
    emailIdentity: `mail.${config.zone}`,
    configurationSetName: emailSet.configurationSetName,
    dkimSigningKeyLength: "RSA_2048_BIT",
    dkimSigningEnabled: true,
  })
  for (const index of [0, 1, 2]) {
    const token = email.dkimTokens.pipe(
      Output.map((tokens) => {
        const value = tokens[index]
        if (value === undefined) throw new Error("SES did not return three Easy DKIM tokens")
        return value
      }),
    )
    yield* Cloudflare.DNS.Record(`Dkim${index}`, {
      zoneId: zone.zoneId,
      name: Output.interpolate`${token}._domainkey.mail.${config.zone}`,
      type: "CNAME",
      content: Output.interpolate`${token}.dkim.amazonses.com`,
      proxied: false,
      ttl: 300,
    })
  }
  const executionRole = yield* AWS.IAM.Role("ExecutionRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
    inlinePolicies: {
      Secrets: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: [
              authSecret.secretArn,
              telemetrySecret.secretArn,
              traceHeaders.secretArn,
              logHeaders.secretArn,
              turnstileSecret.secretArn,
              databaseSecret.secretArn,
              edgeSigningKeys.secretArn,
            ],
          },
          { Effect: "Allow", Action: ["kms:Decrypt"], Resource: secretsKey.keyArn },
        ],
      },
    },
  })
  const runnerExecutionRole = yield* AWS.IAM.Role("RunnerExecutionRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      Images: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
          {
            Effect: "Allow",
            Action: [
              "ecr:BatchCheckLayerAvailability",
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
            ],
            Resource: [
              runnerRepository.repositoryArn,
              `arn:aws:ecr:${config.region}:${config.accountId}:repository/akter/runners/*`,
            ],
          },
        ],
      },
    },
  })
  const taskRole = yield* AWS.IAM.Role("ApiRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      RunnerProvisioning: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["ecs:RegisterTaskDefinition"],
            Resource: `arn:aws:ecs:${config.region}:${config.accountId}:task-definition/akter-runner-*`,
          },
          {
            Effect: "Allow",
            Action: ["ecs:DescribeTaskDefinition"],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["ecs:RunTask"],
            Resource: `arn:aws:ecs:${config.region}:${config.accountId}:task-definition/akter-runner-*`,
            Condition: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
          },
          {
            Effect: "Allow",
            Action: ["ecs:StopTask", "ecs:DescribeTasks"],
            Resource: Output.interpolate`arn:aws:ecs:${config.region}:${config.accountId}:task/${cluster.clusterName}/*`,
            Condition: {
              ArnEquals: { "ecs:cluster": cluster.clusterArn },
              Null: { "aws:ResourceTag/akter:deployment": "false" },
            },
          },
          {
            Effect: "Allow",
            Action: ["ecs:TagResource"],
            Resource: Output.interpolate`arn:aws:ecs:${config.region}:${config.accountId}:task/${cluster.clusterName}/*`,
            Condition: { StringEquals: { "ecs:CreateAction": "RunTask" } },
          },
          {
            Effect: "Allow",
            Action: ["iam:PassRole"],
            Resource: runnerExecutionRole.roleArn,
            Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
          },
        ],
      },
      CustomerEnvironment: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["kms:GenerateDataKey", "kms:Decrypt"],
            Resource: customerKey.keyArn,
          },
        ],
      },
      Email: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["ses:SendEmail"], Resource: email.identityArn }],
      },
    },
  })
  yield* AWS.SSM.Parameter("CustomerKeyParameter", {
    name: `/${config.name}/customer-environment-key`,
    value: customerKey.keyArn,
  })
  const applications = [
    { name: "console", port: 3000, listenerPort: 8443 },
    { name: "api", port: 3001, listenerPort: 2053 },
    { name: "edge", port: 3002, listenerPort: 443 },
  ] as const
  const services = yield* Effect.forEach(applications, (application) =>
    Effect.gen(function* () {
      const repository = yield* AWS.ECR.Repository("Repository", {
        repositoryName: `akter/${application.name}`,
        imageTagMutability: "IMMUTABLE",
        scanOnPush: true,
      })
      const target = yield* AWS.ELBv2.TargetGroup("Target", {
        vpcId: vpc.vpcId,
        port: application.port,
        protocol: "TCP",
        targetType: "ip",
        healthCheckProtocol: "HTTP",
        healthCheckPath: application.name === "api" ? "/ready" : "/health",
        attributes: {
          "deregistration_delay.timeout_seconds": "120",
          "preserve_client_ip.enabled": application.name === "edge" ? "true" : "false",
        },
      })
      const listener = yield* AWS.ELBv2.Listener("Listener", {
        loadBalancerArn: loadBalancer.loadBalancerArn,
        targetGroupArn: target.targetGroupArn,
        port: application.listenerPort,
        protocol: "TLS",
        certificateArn: config.certificateArn,
        sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      })
      const task = yield* AWS.ECS.TaskDefinition("Task", {
        family: `${config.name}-${application.name}`,
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
        cpu: "512",
        memory: "1024",
        executionRoleArn: executionRole,
        taskRoleArn: application.name === "api" ? taskRole : undefined,
        containerDefinitions: [
          {
            name: application.name,
            image: Output.interpolate`${repository.repositoryUri}:${config.imageTag}`,
            essential: true,
            portMappings: [{ containerPort: application.port, protocol: "tcp" }],
            environment: [
              { name: "NODE_ENV", value: "production" },
              { name: "PORT", value: String(application.port) },
              ...(application.name === "api"
                ? [
                    { name: "API_PORT", value: String(application.port) },
                    { name: "API_HOST", value: "0.0.0.0" },
                    { name: "API_PRODUCTION", value: "true" },
                    { name: "API_ORIGIN", value: `https://api.${config.zone}` },
                    { name: "CONSOLE_ORIGIN", value: `https://app.${config.zone}` },
                    { name: "EMAIL_MODE", value: "ses" },
                    { name: "EMAIL_FROM", value: `Akter <auth@mail.${config.zone}>` },
                    { name: "EDGE_ORIGIN", value: `https://edge.${config.zone}` },
                    { name: "DEPLOYMENT_DOMAIN", value: `apps.${config.zone}` },
                    {
                      name: "RUNNER_ECS_CONFIG",
                      value: Output.all(
                        cluster.clusterArn,
                        runnerGroup.groupId,
                        runnerExecutionRole.roleArn,
                        ...subnets.map(({ privateSubnetId }) => privateSubnetId),
                      ).pipe(
                        Output.map(([clusterArn, groupId, roleArn, ...privateSubnets]) =>
                          JSON.stringify({
                            regions: {
                              [config.region]: {
                                cluster: clusterArn,
                                subnets: privateSubnets,
                                securityGroups: [groupId],
                              },
                            },
                            container: "runner",
                            port: 8080,
                            definition: { executionRoleArn: roleArn },
                          }),
                        ),
                      ),
                    },
                  ]
                : []),
              ...(application.name === "edge"
                ? [
                    { name: "EDGE_NLB_ONLY", value: "true" },
                    {
                      name: "EDGE_CLOUDFLARE_RANGES",
                      value:
                        "173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22",
                    },
                    { name: "EDGE_ISSUER", value: `https://edge.${config.zone}` },
                  ]
                : []),
              { name: "AWS_REGION", value: config.region },
              { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "https://api.axiom.co" },
              { name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "http/protobuf" },
              { name: "OTEL_SERVICE_NAME", value: application.name },
              { name: "AXIOM_DATASET", value: dataset.name },
              { name: "AXIOM_LOG_DATASET", value: logs.name },
              { name: "TURNSTILE_SITEKEY", value: turnstile.sitekey },
            ],
            secrets: [
              { name: "AXIOM_TOKEN", valueFrom: telemetrySecret.secretArn },
              { name: "OTEL_EXPORTER_OTLP_TRACES_HEADERS", valueFrom: traceHeaders.secretArn },
              { name: "OTEL_EXPORTER_OTLP_LOGS_HEADERS", valueFrom: logHeaders.secretArn },
              ...(application.name === "console"
                ? []
                : [{ name: "CONTROL_PLANE_DATABASE_URL", valueFrom: databaseSecret.secretArn }]),
              ...(application.name === "edge"
                ? [{ name: "EDGE_SIGNING_KEYS", valueFrom: edgeSigningKeys.secretArn }]
                : []),
              ...(application.name === "api"
                ? [
                    {
                      name: "AUTH_SECRET",
                      valueFrom: Output.interpolate`${authSecret.secretArn}:password::`,
                    },
                    { name: "TURNSTILE_SECRET", valueFrom: turnstileSecret.secretArn },
                  ]
                : []),
            ],
          },
        ],
      })
      const declareService: Effect.Effect<AWS.ECS.Service, never, AWS.Providers> = AWS.ECS.Service<
        never,
        never
      >("Service", {
        cluster,
        task,
        serviceName: application.name,
        desiredCount: application.name === "api" ? 1 : config.stage === "prod" ? 2 : 1,
        subnets: subnets.map(({ privateSubnetId }) => privateSubnetId),
        vpcId: vpc.vpcId,
        securityGroups: [application.name === "edge" ? edgeGroup.groupId : servicesGroup.groupId],
        assignPublicIp: false,
        capacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }],
        loadBalancers: [
          {
            targetGroupArn: listener.targetGroupArn,
            containerName: application.name,
            containerPort: application.port,
          },
        ],
      })
      const service = yield* declareService
      const hostname = `${application.name === "console" ? "app" : application.name}.${config.zone}`
      const dns = yield* Cloudflare.DNS.Record("Dns", {
        zoneId: zone.zoneId,
        name: hostname,
        type: "CNAME",
        content: loadBalancer.dnsName,
        proxied: true,
        ttl: 1,
      })
      return {
        name: application.name,
        hostname,
        origin: dns.name,
        listenerPort: application.listenerPort,
        serviceArn: service.serviceArn,
        repository: repository.repositoryUri,
      }
    }).pipe(Namespace.push(application.name)),
  )
  yield* Cloudflare.Ruleset.Ruleset("OriginPorts", {
    zone,
    phase: "http_request_origin",
    rules: services.map((service) => ({
      ref: service.name,
      expression: `http.host eq "${service.hostname}"`,
      action: "route",
      actionParameters: { origin: { port: service.listenerPort } },
    })),
  })
  const edge = services.find((service) => service.name === "edge")
  if (edge === undefined)
    return yield* Effect.die(new Error("Edge DNS is required for the SaaS origin"))
  const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin("CustomerOrigin", {
    zoneId: zone.zoneId,
    origin: edge.origin,
  })
  yield* Effect.forEach(config.customHostnames, (hostname) =>
    Cloudflare.CustomHostname.CustomHostname(hostname, {
      zoneId: zone.zoneId,
      hostname,
      ssl: { method: "txt", type: "dv" },
      customOriginServer: fallback.origin,
      customOriginSni: fallback.origin,
    }).pipe(Namespace.push("CustomerHosts")),
  )
  return {
    stage: config.stage,
    region: config.region,
    accountId: config.accountId,
    stateBucket: stateBucket.bucketName,
    vpcId: vpc.vpcId,
    clusterArn: cluster.clusterArn,
    nlbHostname: loadBalancer.dnsName,
    runnerRepository: runnerRepository.repositoryUri,
    services,
    customerEnvironmentKeyArn: customerKey.keyArn,
    customHostnameOrigin: fallback.origin,
    turnstileSitekey: turnstile.sitekey,
    databaseId: database.id,
    databaseConnections: {
      runtime: databaseRole.connectionUrl,
      migrations: migrationRole.connectionUrl,
    },
  }
})
