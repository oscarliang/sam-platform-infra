import * as cdk from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_ec2 as ec2, aws_eks as eks, aws_iam as iam, aws_rds as rds, aws_secretsmanager as secretsmanager, aws_apigatewayv2 as apigateway, aws_apigatewayv2_integrations as apig_int, aws_cognito as cognito, aws_elasticache as elasticache} from 'aws-cdk-lib';
import { InstanceType } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

const fs = require('fs');
const yaml = require('js-yaml');

export class SamPlatformInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    let config;

    try {
      const env = process.env.NODE_ENV;
      let configFile;

      switch (env) {
        case 'production':
          configFile = './config.prod.yaml';
          break;
        case 'nonprod':
          configFile = './config.nonprod.yaml';
          break;
        default:
          configFile = './config.dev.yaml';
      }

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

    const apigConfig = config.APIG;

    // Create the HTTP APIG
    const httpApi = new apigateway.HttpApi(this, 'MyHttpApi', {
      apiName: apigConfig.name,
      createDefaultStage: false
    });

    // Create the custom stage
    new apigateway.HttpStage(this, 'MyStage', {
      httpApi: httpApi,
      stageName: apigConfig.stageName,
      autoDeploy: true
    });    

    // Create the security group for the VPC link
    const securityGroup = new ec2.SecurityGroup(this, 'VPCLinkSecurityGroup', {
      vpc,
      securityGroupName: 'vpc-link',
      description: 'Security group for API Gateway VPC link',
    });
    // Add egress rule
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allTraffic(),
      'Allow all outbound traffic'
    );

    // Create a VPC link for API Gateway
    const vpcLink = new apigateway.VpcLink(this, 'EksVpcLink', {
      vpcLinkName: 'eks',
      vpc,
      subnets: {
        subnets: vpc.privateSubnets
      },
      securityGroups: [securityGroup]
    });

    // ********************** Cognito User Pool *****************************
    const cognitoConfig = config.COGNITO;

    const userPool = new cognito.UserPool(this, 'samMain', {
      userPoolName: 'sam-main',
      selfSignUpEnabled: true,
      deletionProtection: true,
      userVerification: {
        emailSubject: 'Your verification code',
        emailBody: 'Your verification code is {####}.',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      signInAliases: {
        email: true,
        username: true,
        phone: true,
      },
      autoVerify: { email: true },
      keepOriginal: {email: true},
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,

      // MFA configurations
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: false,
      },

    });

    // Create the User Groups in the User Pool
    const userGroup = new cognito.CfnUserPoolGroup(this, 'acManagers', {
      groupName: 'ac-managers',
      userPoolId: userPool.userPoolId,
      description: 'Full access to the art centre',
    });

    const userGroup1 = new cognito.CfnUserPoolGroup(this, 'acWorkers', {
      groupName: 'ac-workers',
      userPoolId: userPool.userPoolId,
      description: 'Catalogue artworks and products, Manage artists, conduct sales, create consignments',
    });

    const userGroup2 = new cognito.CfnUserPoolGroup(this, 'admins', {
      groupName: 'admins',
      userPoolId: userPool.userPoolId,
      description: 'Full access to the system',
    });

    const userGroup3 = new cognito.CfnUserPoolGroup(this, 'artists', {
      groupName: 'artists',
      userPoolId: userPool.userPoolId,
      description: 'Add and edit artwork, Manage the profile information, view money story',
    });

    const userGroup4 = new cognito.CfnUserPoolGroup(this, 'bookkeepers', {
      groupName: 'bookkeepers',
      userPoolId: userPool.userPoolId,
      description: 'Make payments to artists, manage art centre accounts ',
    });

    // Set up a domain for the user pool
    const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: cognitoConfig.domainPrefix
      }
    });

    // Setup a Cognito User Pool Client
    const userPoolClient = new cognito.UserPoolClient(this, 'AppClient', {
      userPoolClientName: 'sam-website',
      userPool,
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
      // OAuth settings
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PHONE,
        ],
        callbackUrls: [cognitoConfig.callbackUrl],
        logoutUrls: [cognitoConfig.logoutUrl],
      },

    });

   // ********************** ElastiCache Redis *****************************
   const redisConfig = config.ELASTICACHE.REDIS;

   const redisSecurityGroup = new ec2.SecurityGroup(this, redisConfig.security_group_name, {
     vpc,
     description: 'Security group for ElastiCache Redis',
     allowAllOutbound: true,
   });

   redisSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpcConfigs.vpc_cidr), ec2.Port.tcp(6379), 'Allow Redis traffic');

   const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, redisConfig.subnet_group_name, {
     description: 'Subnet group for ElastiCache Redis',
     subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
     cacheSubnetGroupName: redisConfig.subnet_group_name,
   });

   new elasticache.CfnCacheCluster(this, redisConfig.cache_cluster_id, {
     cacheNodeType: redisConfig.node_type,
     engine: 'redis',
     numCacheNodes: redisConfig.num_cache_nodes,
     clusterName: redisConfig.cache_cluster_id,
     vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
     cacheSubnetGroupName: redisConfig.subnet_group_name,
     engineVersion: redisConfig.engine_version,
   });    

  }
}
