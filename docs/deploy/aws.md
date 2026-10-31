# AWS

On AWS, the server runs as one task on [ECS](https://aws.amazon.com/ecs/) with Fargate, behind an Application Load Balancer, and the store is an S3 bucket. The task reaches the bucket with an IAM role, so there are no keys to manage. Alchemy's [AWS provider](https://alchemy.run/aws) builds the image, pushes it to ECR and creates everything else.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md).
- Docker running locally. Alchemy builds the image on your machine.
- An AWS account you can create VPCs, IAM roles, ECS services and S3 buckets in.

## Install

```sh
bun add -d alchemy @alchemy.run/aws
```

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as AWS from "@alchemy.run/aws"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { Config, Effect } from "effect"

export default Alchemy.Stack(
  "my-app",
  { providers: AWS.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("Store", { objectLockEnabled: false })
    const storeAccess = yield* AWS.IAM.Policy("StoreAccess", {
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: Output.interpolate`${bucket.bucketArn}/*`,
          },
          { Effect: "Allow", Action: ["s3:ListBucket"], Resource: bucket.bucketArn },
        ],
      },
    })

    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 2,
      nat: "none",
    })
    const lbSecurityGroup = yield* AWS.EC2.SecurityGroup("LoadBalancerSecurityGroup", {
      vpcId: network.vpcId,
      description: "Akter load balancer",
      ingress: [{ ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: "0.0.0.0/0" }],
    })
    const taskSecurityGroup = yield* AWS.EC2.SecurityGroup("TaskSecurityGroup", {
      vpcId: network.vpcId,
      description: "Akter server",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 8080,
          toPort: 8080,
          referencedGroupId: lbSecurityGroup.groupId,
        },
      ],
    })

    const loadBalancer = yield* AWS.ELBv2.LoadBalancer("LoadBalancer", {
      type: "application",
      scheme: "internet-facing",
      subnets: network.publicSubnetIds,
      securityGroups: [lbSecurityGroup.groupId],
      attributes: { "idle_timeout.timeout_seconds": "3600" },
    })
    const targetGroup = yield* AWS.ELBv2.TargetGroup("TargetGroup", {
      vpcId: network.vpcId,
      port: 8080,
      protocol: "HTTP",
      targetType: "ip",
      healthCheckPath: "/ready",
      healthCheckInterval: "10 seconds",
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      attributes: { "deregistration_delay.timeout_seconds": "5" },
    })
    const listener = yield* AWS.ELBv2.Listener("Listener", {
      loadBalancerArn: loadBalancer.loadBalancerArn,
      port: 80,
      protocol: "HTTP",
      defaultActions: [
        { type: "forward", targetGroups: [{ targetGroupArn: targetGroup.targetGroupArn }] },
      ],
    })

    const cluster = yield* AWS.ECS.Cluster("Cluster", {})
    yield* AWS.ECS.Service("Server", {
      cluster,
      context: ".",
      port: 8080,
      cpu: 512,
      memory: 1024,
      runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
      container: { name: "server", stopTimeout: 30, linuxParameters: { initProcessEnabled: true } },
      env: {
        AKTER_STORAGE_BUCKET: bucket.bucketName,
        AKTER_STORAGE_REGION: bucket.region,
        AUTH_ISSUER: yield* Config.String("AUTH_ISSUER"),
        AUTH_AUDIENCE: yield* Config.String("AUTH_AUDIENCE"),
        AUTH_JWKS_URL: yield* Config.String("AUTH_JWKS_URL"),
      },
      taskRoleManagedPolicyArns: [storeAccess.policyArn],
      logging: { retention: "30 days" },
      desiredCount: 1,
      launchType: "FARGATE",
      vpcId: network.vpcId,
      subnets: network.publicSubnetIds,
      securityGroups: [taskSecurityGroup.groupId],
      assignPublicIp: true,
      loadBalancers: [
        {
          targetGroupArn: Output.all(targetGroup.targetGroupArn, listener.listenerArn).pipe(
            Output.map(([targetGroupArn]) => targetGroupArn),
          ),
          containerName: "server",
          containerPort: 8080,
        },
      ],
      healthCheckGracePeriod: "60 seconds",
      availabilityZoneRebalancing: "DISABLED",
      deploymentConfiguration: {
        strategy: "ROLLING",
        minimumHealthyPercent: 0,
        maximumPercent: 100,
      },
    })

    return { url: Output.interpolate`http://${loadBalancer.dnsName}`, bucket: bucket.bucketName }
  }),
)
```

- **`Store`** is the bucket, and **`StoreAccess`** lets the task read, write, list and delete in it and nowhere else. The server finds its credentials through the role, so it needs no `AKTER_STORAGE_ENDPOINT` or keys.
- **`Network`** is a VPC with public subnets and no NAT gateway. The task gets a public address to pull its image and reach S3, but only the load balancer can reach port 8080.
- **The load balancer** checks `/ready` and sends traffic only to a task that answers `200`. Its idle timeout is an hour, so WebSockets and long streams stay open, and its deregistration delay is 5 seconds, so a release doesn't wait half a minute before stopping the old task.
- **`deploymentConfiguration`** is what makes releases safe. `maximumPercent: 100` never lets ECS run a second task, and `minimumHealthyPercent: 0` lets it stop the old task before starting the new one. Without them, ECS starts the new task first.
- **`stopTimeout: 30`** gives the server 30 seconds after SIGTERM. `initProcessEnabled` runs a small init process that passes the signal on to Bun.
- **`availabilityZoneRebalancing: "DISABLED"`** is required with `maximumPercent: 100`.
- **The target group's ARN waits for the listener**, because ECS refuses a target group that isn't attached to a load balancer yet.
- **`AWS.state()`** keeps Alchemy's state in an S3 bucket in your account.

## Deploy

Connect your AWS account once:

```sh
bun alchemy profile edit --add AWS
```

It offers SSO, the console login, or access keys, and asks for a region. In CI, Alchemy reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`; run `bun alchemy state bootstrap --backend aws` once first. Then deploy:

```sh
bun alchemy deploy --stage prod
```

Alchemy creates the network, the bucket and the load balancer, builds and pushes the image, and waits until the task passes its health check. It prints the load balancer's URL. Check the server:

```sh
curl <url>/ready
```

To check the bucket, run `bunx akter storage check --bucket <bucket> --region <region>` with your own AWS credentials. See [Check it](overview.md#check-it).

## HTTPS

For HTTPS, put the domain in a Route 53 hosted zone, allow port 443 on the load balancer's security group, and replace the listener with these:

```ts
const domain = yield * Config.String("DOMAIN")
const { region } = yield * AWS.AWSEnvironment.current
const certificate = yield * AWS.ACM.Certificate("Certificate", { domainName: domain, region })

const listener =
  yield *
  AWS.ELBv2.Listener("HttpsListener", {
    loadBalancerArn: loadBalancer.loadBalancerArn,
    port: 443,
    protocol: "HTTPS",
    certificateArn: certificate.certificateArn,
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    defaultActions: [
      { type: "forward", targetGroups: [{ targetGroupArn: targetGroup.targetGroupArn }] },
    ],
  })
yield *
  AWS.ELBv2.Listener("HttpListener", {
    loadBalancerArn: loadBalancer.loadBalancerArn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{ type: "redirect", statusCode: "HTTP_301", protocol: "HTTPS", port: "443" }],
  })
yield *
  AWS.Route53.Record("Domain", {
    name: domain,
    type: "A",
    aliasTarget: {
      hostedZoneId: loadBalancer.canonicalHostedZoneId,
      dnsName: loadBalancer.dnsName,
      evaluateTargetHealth: false,
    },
  })
```

Alchemy finds the hosted zone, validates the certificate through it, and points the name at the load balancer. The certificate's `region` has to be the load balancer's; it defaults to `us-east-1`, which is for CloudFront.

## Releases

Run `bun alchemy deploy --stage prod` again. ECS takes the old task out of the load balancer, sends it SIGTERM, and starts the new task once the old one is stopping. ECS doesn't wait for the old task's process to exit before it starts provisioning the new one, but a new Fargate task takes far longer to get its network and pull its image than the server takes to drain. Expect about a minute without a server per release. Clients retry through it.

Every change to the service, even an environment variable, replaces the task.

`bun alchemy destroy --stage prod` removes the stack. It keeps the bucket while it holds objects, so your data survives.
