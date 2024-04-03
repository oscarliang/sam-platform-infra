import * as cdk from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_ec2 as ec2, aws_eks as eks, aws_iam as iam, aws_rds as rds, aws_secretsmanager as secretsmanager} from 'aws-cdk-lib';
import { InstanceType } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

const fs = require('fs');
const yaml = require('js-yaml');

export class SamPlatformInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    let config;

    try {
      const env = process.env.NODE_ENV || 'development';
      const configFile = env === 'production' ? './config.prod.yaml' : './config.dev.yaml';

      const fileContents = fs.readFileSync(configFile, 'utf8');
      config = yaml.load(fileContents);

    } catch (e) {
      console.error(e);
    }

    // ********************** S3 *****************************
    // Access and iterate over the S3 configurations
    const s3Configs = config.S3;

    // Create S3 buckets based on the provided names
    s3Configs.forEach((s3Config: { bucket_name: string; type: string }) => {
      // Create S3 buckets based on the configuration
      new s3.Bucket(this, s3Config.bucket_name, {
        bucketName: s3Config.bucket_name,
        versioned: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true
      });
    });

    // ********************** VPC *****************************
    // Create a VPC with specified CIDR block
    const vpcConfigs = config.VPC.reduce((acc: any, item: any) => ({ ...acc, ...item }), {});

    const vpc = new ec2.Vpc(this, vpcConfigs.vpc_name, {
      cidr: vpcConfigs.vpc_cidr,
      maxAzs: vpcConfigs.max_azs,
      natGateways: vpcConfigs.nat_gateways,

      // Define subnet configuration
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ********************** RDS *****************************
    const rdsConfig = config.RDS;

    const dbSubnetGroup = new rds.SubnetGroup(this, rdsConfig.db_subnet_group_name, {
      vpc,
      subnetGroupName: rdsConfig.db_subnet_group_name,
      description: 'Database Subnet Group',
      vpcSubnets: { subnets: vpc.privateSubnets },
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, rdsConfig.db_security_group_name, {
      vpc,
      securityGroupName: rdsConfig.db_security_group_name,
      description: 'Security group for the RDS DB Instance',
      allowAllOutbound: true,
    });

    dbSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpcConfigs.vpc_cidr), ec2.Port.tcp(3306));

    const secret = new secretsmanager.Secret(this, rdsConfig.db_secret_name, {
      secretName: rdsConfig.db_secret_name,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: rdsConfig.master_username }),
        generateStringKey: 'password',
        passwordLength: 12,
        excludeCharacters: '"@/\\',
      },
    });

    const dbInstance = new rds.DatabaseInstance(this, rdsConfig.db_instance_identifier, {
      instanceIdentifier: rdsConfig.db_instance_identifier,
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: rdsConfig.db_instance_class,
      vpc,
      vpcSubnets: { subnets: vpc.privateSubnets },
      securityGroups: [dbSecurityGroup],
      databaseName: rdsConfig.db_name,
      allocatedStorage: rdsConfig.allocated_storage,
      credentials: rds.Credentials.fromSecret(secret),
      subnetGroup: dbSubnetGroup,
      deletionProtection: rdsConfig.deletion_protection,
      backupRetention: cdk.Duration.days(rdsConfig.backup_retention_period),
      multiAz: rdsConfig.multi_az,
    });

    // ********************** EKS Cluster *****************************
    const eksConfig = config.EKS;

    // EKS Cluster Role
    const eksClusterRole = new iam.Role(this, 'EKSClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSServicePolicy'),
      ],
    });

    // EKS Node Role
    const eksNodeRole = new iam.Role(this, 'EKSNodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
      ],
    });

    // EKS Cluster
    const cluster = new eks.Cluster(this, eksConfig.cluster.name, {
      clusterName: eksConfig.cluster.name,
      version: eks.KubernetesVersion.V1_28,
      vpc: vpc,
      defaultCapacity: 0,
      role: eksClusterRole,
    });


    // EKS Node Group
    cluster.addNodegroupCapacity('EKSNodeGroup', {
      nodegroupName: eksConfig.nodeGroup.name,
      amiType: eks.NodegroupAmiType.AL2_X86_64,
      capacityType: eks.CapacityType.SPOT,
      desiredSize: eksConfig.nodeGroup.desiredSize,
      maxSize: eksConfig.nodeGroup.maxSize,
      minSize: eksConfig.nodeGroup.minSize,
      diskSize: eksConfig.nodeGroup.diskSize,
      instanceTypes: [new ec2.InstanceType('t3.medium'), new ec2.InstanceType('t3.large')],
      nodeRole: eksNodeRole,
      subnets: {subnets: vpc.privateSubnets,},
    });

  }
}
