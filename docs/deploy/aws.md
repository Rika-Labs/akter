# AWS

On AWS, the server runs as one task on [ECS](https://aws.amazon.com/ecs/) with Fargate, behind an Application Load Balancer, and the store is an S3 bucket. The task reaches the bucket with an IAM role, so there are no keys to manage. The [AWS CDK](https://docs.aws.amazon.com/cdk/) describes it all in one TypeScript file.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md). Add `cdk.out` to `.dockerignore`.
- Docker running locally. The CDK builds the image and pushes it to ECR.
- AWS credentials in your shell, for example from `aws sso login`.

## Install

```sh
bun add -d aws-cdk-lib constructs aws-cdk
echo '{ "app": "bun infra/aws.ts" }' > cdk.json
```

## Describe the stack

Create `infra/aws.ts`:

```ts
import { App, CfnOutput, Duration, Stack } from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecs from "aws-cdk-lib/aws-ecs"
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns"
import { Platform } from "aws-cdk-lib/aws-ecr-assets"
import * as s3 from "aws-cdk-lib/aws-s3"

const app = new App()
const stack = new Stack(app, "MyApp")

const store = new s3.Bucket(stack, "Store", {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
})

const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 2, natGateways: 0 })

const server = new ApplicationLoadBalancedFargateService(stack, "Server", {
  vpc,
  cpu: 512,
  memoryLimitMiB: 1024,
  desiredCount: 1,
  minHealthyPercent: 0,
  maxHealthyPercent: 100,
  circuitBreaker: { rollback: true },
  assignPublicIp: true,
  taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
  idleTimeout: Duration.hours(1),
  taskImageOptions: {
    image: ecs.ContainerImage.fromAsset(".", { platform: Platform.LINUX_AMD64 }),
    containerPort: 8080,
    environment: {
      AKTER_STORAGE_BUCKET: store.bucketName,
      AKTER_STORAGE_REGION: stack.region,
      AUTH_ISSUER: "https://login.example.com/",
      AUTH_AUDIENCE: "my-app",
      AUTH_JWKS_URL: "https://login.example.com/.well-known/jwks.json",
    },
  },
})

server.targetGroup.configureHealthCheck({ path: "/ready", interval: Duration.seconds(10) })
server.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "5")
store.grantReadWrite(server.taskDefinition.taskRole)

new CfnOutput(stack, "Bucket", { value: store.bucketName })
```

- **`desiredCount: 1`** runs one server.
- **`minHealthyPercent: 0` and `maxHealthyPercent: 100`** make every deploy stop the old task before it starts the new one. ECS's default does the opposite.
- **`circuitBreaker`** rolls back to the previous release if the new task never becomes healthy.
- **`idleTimeout`** keeps quiet WebSocket sessions and streams open for up to an hour. The load balancer's default is 60 seconds.
- **The health check** asks `/ready`, and the short deregistration delay stops the load balancer from waiting five minutes before ECS sends SIGTERM.
- **`grantReadWrite`** lets the task's role use the bucket. The server leaves `AWS_ACCESS_KEY_ID` unset and the AWS SDK picks the role up by itself.
- **The network** is a new VPC with public subnets and no NAT gateways, which cost money every hour. The task gets a public IP to reach S3 and pull its image, and its security group only lets the load balancer in.

## Deploy

```sh
bunx cdk bootstrap
bunx cdk deploy
```

`cdk bootstrap` prepares the account and region once. `cdk deploy` builds the image, pushes it, creates everything, and prints the load balancer's URL as `ServiceURL` along with the bucket's name. Check the server:

```sh
curl http://<ServiceURL>/ready
```

Check the bucket from your machine. With no keys set, the check uses your AWS login:

```sh
bunx akter storage check --bucket <Bucket> --region <your region>
```

## HTTPS

The stack above serves plain HTTP. For HTTPS, add your domain's Route 53 zone, a name and the protocol to the service:

```ts
import { ApplicationProtocol } from "aws-cdk-lib/aws-elasticloadbalancingv2"
import { HostedZone } from "aws-cdk-lib/aws-route53"

const zone = HostedZone.fromLookup(stack, "Zone", { domainName: "example.com" })

new ApplicationLoadBalancedFargateService(stack, "Server", {
  domainName: "api.example.com",
  domainZone: zone,
  protocol: ApplicationProtocol.HTTPS,
  redirectHTTP: true,
  // ...everything else as above
})
```

The CDK requests a certificate, validates it through the zone, and points the name at the load balancer. `fromLookup` needs the stack's account and region, so pass `env: { account, region }` to `new Stack`.

## Releases

Run `bunx cdk deploy` again. ECS takes the old task out of the load balancer, sends it SIGTERM, waits up to 30 seconds for it to exit, then starts the new task. Fargate needs about a minute to start a task and pass the health check, so expect that much downtime per release. Clients retry through it.

`bunx cdk destroy` removes the stack but keeps the bucket, so your data survives. Delete the bucket yourself if you mean to.
