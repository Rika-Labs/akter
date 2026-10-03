import * as AWS from "alchemy/AWS"
import * as Namespace from "alchemy/Namespace"
import * as Output from "alchemy/Output"
import { Effect } from "effect"
import type { Deployment } from "./config.ts"

/** Private service subnets use one NAT per availability zone so image pulls survive an AZ loss. */
export const network = (config: Deployment) =>
  Effect.gen(function* () {
    const vpc = yield* AWS.EC2.Vpc("Vpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: { Name: config.name },
    })
    const gateway = yield* AWS.EC2.InternetGateway("InternetGateway", { vpcId: vpc.vpcId })
    const subnets = yield* Effect.forEach([0, 1], (index) =>
      Effect.gen(function* () {
        const availabilityZone = `${config.region}${index === 0 ? "a" : "b"}`
        const publicSubnet = yield* AWS.EC2.Subnet("Public", {
          vpcId: vpc.vpcId,
          cidrBlock: `10.0.${index}.0/24`,
          availabilityZone,
        })
        const publicRoutes = yield* AWS.EC2.RouteTable("PublicRoutes", { vpcId: vpc.vpcId })
        const internetRoute = yield* AWS.EC2.Route("InternetRoute", {
          routeTableId: publicRoutes.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: gateway.internetGatewayId,
        })
        const publicAssociation = yield* AWS.EC2.RouteTableAssociation("PublicAssociation", {
          routeTableId: internetRoute.routeTableId,
          subnetId: publicSubnet.subnetId,
        })
        const publicSubnetId = publicAssociation.subnetId.pipe(
          Output.map((subnetId) => {
            if (subnetId === undefined) throw new Error("Public route table is not associated")
            return subnetId
          }),
        )
        const address = yield* AWS.EC2.EIP("NatAddress", { domain: "vpc" })
        const nat = yield* AWS.EC2.NatGateway("Nat", {
          subnetId: publicSubnetId,
          allocationId: address.allocationId,
        })
        const privateSubnet = yield* AWS.EC2.Subnet("Private", {
          vpcId: vpc.vpcId,
          cidrBlock: `10.0.${index + 16}.0/24`,
          availabilityZone,
        })
        const privateRoutes = yield* AWS.EC2.RouteTable("PrivateRoutes", { vpcId: vpc.vpcId })
        const natRoute = yield* AWS.EC2.Route("NatRoute", {
          routeTableId: privateRoutes.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: nat.natGatewayId,
        })
        const privateAssociation = yield* AWS.EC2.RouteTableAssociation("PrivateAssociation", {
          routeTableId: natRoute.routeTableId,
          subnetId: privateSubnet.subnetId,
        })
        const privateSubnetId = privateAssociation.subnetId.pipe(
          Output.map((subnetId) => {
            if (subnetId === undefined) throw new Error("Private route table is not associated")
            return subnetId
          }),
        )
        return { publicSubnetId, privateSubnetId }
      }).pipe(Namespace.push(`Az${index}`)),
    )
    const loadBalancerGroup = yield* AWS.EC2.SecurityGroup("LoadBalancerGroup", {
      vpcId: vpc.vpcId,
      ingress: [443, 8443, 2053].flatMap((port) =>
        [
          "173.245.48.0/20",
          "103.21.244.0/22",
          "103.22.200.0/22",
          "103.31.4.0/22",
          "141.101.64.0/18",
          "108.162.192.0/18",
          "190.93.240.0/20",
          "188.114.96.0/20",
          "197.234.240.0/22",
          "198.41.128.0/17",
          "162.158.0.0/15",
          "104.16.0.0/13",
          "104.24.0.0/14",
          "172.64.0.0/13",
          "131.0.72.0/22",
        ].map((cidrIpv4) => ({
          ipProtocol: "tcp",
          fromPort: port,
          toPort: port,
          cidrIpv4,
        })),
      ),
    })
    const servicesGroup = yield* AWS.EC2.SecurityGroup("ServicesGroup", {
      vpcId: vpc.vpcId,
      ingress: [3000, 3001, 3002].map((port) => ({
        ipProtocol: "tcp",
        fromPort: port,
        toPort: port,
        referencedGroupId: loadBalancerGroup.groupId,
      })),
    })
    const loadBalancer = yield* AWS.ELBv2.LoadBalancer("Nlb", {
      name: config.name,
      type: "network",
      scheme: "internet-facing",
      subnets: subnets.map(({ publicSubnetId }) => publicSubnetId),
      securityGroups: [loadBalancerGroup.groupId],
      attributes: {
        "load_balancing.cross_zone.enabled": "true",
        "deletion_protection.enabled": config.stage === "prod" ? "true" : "false",
      },
    })
    return { vpc, subnets, loadBalancer, servicesGroup }
  })
