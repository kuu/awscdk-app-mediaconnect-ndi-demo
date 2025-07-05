import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnFlowOutput } from 'aws-cdk-lib/aws-mediaconnect';
import { LiveFeedFromFile } from 'awscdk-construct-mediaconnect-flow';

export class AwscdkAppMediaconnectNdiDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const {flow, vpc, ndiDiscoveryServer} = new LiveFeedFromFile(this, 'LiveFeed', {
      file: {
        type: 'MP4_FILE', // MP4 or TS
        url: 'https://www.acrovid.com/downloads/videos/demo1_60p_converted_to_30p.mp4', // Replace with your S3 or Web URL
      },
      encoderSpec: { // optional: Default is 1080p@30
        framerateNumerator: 30000,
        framerateDenominator: 1001,
        scanType: 'INTERLACED',
        width: 1280,
        height: 720,
      },
      source: {
        protocol: 'SRT',
        type: 'VPC-SOURCE',
      },
      vpcConfig: {
        props: {
          ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
          flowLogs: {
            'video-flow-logs': {
              destination: ec2.FlowLogDestination.toCloudWatchLogs(),
            },
          },
        },
        enableNDI: true,
      },
    });

    if (vpc) {
      // Create an NDI receiver instance
      const instance = createNdiReceiverHost(this, vpc);

      // Create an NDI output for the MediaConnect Flow
      const output = new CfnFlowOutput(this, 'MyCfnFlowOutput', {
        flowArn: flow.attrFlowArn,
        name: 'lcp-demo-ndi-output',
        protocol: 'ndi-speed-hq',
        ndiSpeedHqQuality: 100,
      });
      output.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    // Access MediaConnect flow attributes via `flow`
    new cdk.CfnOutput(this, "MediaConnectFlow", {
      value: flow.attrFlowArn,
      exportName: cdk.Aws.STACK_NAME + "MediaConnectFlow",
      description: "MediaConnect Flow ARN",
    });

    if (ndiDiscoveryServer) {
      // Output the NDI Discovery Server IP address
      new cdk.CfnOutput(this, "NDIDiscoveryServer", {
        value: ndiDiscoveryServer.instancePrivateIp,
        exportName: cdk.Aws.STACK_NAME + "NDIDiscoveryServer",
        description: "NDI Discovery Server IP address",
      });
    }
  }
}

function createNdiReceiverHost(scope: Construct, vpc: ec2.IVpc): ec2.Instance {
  // Create VPC endpoints for SSM connectivity from private subnet
  new ec2.InterfaceVpcEndpoint(scope, 'SSMEndpoint', {
    vpc,
    service: ec2.InterfaceVpcEndpointAwsService.SSM,
    privateDnsEnabled: true,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });
  
  new ec2.InterfaceVpcEndpoint(scope, 'SSMMessagesEndpoint', {
    vpc,
    service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    privateDnsEnabled: true,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });
  
  new ec2.InterfaceVpcEndpoint(scope, 'EC2MessagesEndpoint', {
    vpc,
    service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
    privateDnsEnabled: true,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });
  
  // Create a security group
  const sg = new ec2.SecurityGroup(scope, 'NDIHostSecurityGroup', {
    vpc,
    description: 'Allow RDP and NDI connections',
    allowAllOutbound: true,
  });
  sg.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3389), 'Allow RDP connections');
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcpRange(5959, 65535), 'Allow NDI traffic');
  
  // Create IAM role for the instance
  const instanceRole = new iam.Role(scope, 'G4dnInstanceRole', {
    assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    ],
  });

  // Create user data with RDP password and NVIDIA driver installation
  const userData = ec2.UserData.forWindows();
  
  userData.addCommands('<powershell>',
    '# Set execution policy to allow script execution',
    'Set-ExecutionPolicy Unrestricted -Force',
    
    '# Create log directory for troubleshooting',
    'New-Item -Path "C:\\SetupLogs" -ItemType Directory -Force',
    'Start-Transcript -Path "C:\\SetupLogs\\userdata-execution.log" -Append',
    'Write-Output "Starting UserData script execution at $(Get-Date)"',
    
    '# Disable EC2Launch password generation',
    'try {',
    '    $EC2LaunchSettingsFile = "C:\\ProgramData\\Amazon\\EC2Launch\\settings\\LaunchConfig.json"',
    '    if (Test-Path $EC2LaunchSettingsFile) {',
    '        $EC2LaunchSettings = Get-Content $EC2LaunchSettingsFile | ConvertFrom-Json',
    '        $EC2LaunchSettings.adminPasswordType = "Specify"',
    '        $EC2LaunchSettings.adminPassword = "AdminPass123!"',
    '        $EC2LaunchSettings | ConvertTo-Json -Depth 5 | Set-Content $EC2LaunchSettingsFile',
    '        Write-Output "EC2Launch settings updated to use specified password"',
    '    } else {',
    '        Write-Output "EC2Launch settings file not found"',
    '    }',
    '} catch {',
    '    Write-Output "Error updating EC2Launch settings: $_"',
    '}',
    
    '# Set Administrator password',
    'try {',
    '    $AdminPassword = "AdminPass123!"',
    '    $SecurePassword = ConvertTo-SecureString $AdminPassword -AsPlainText -Force',
    '    Set-LocalUser -Name Administrator -Password $SecurePassword -PasswordNeverExpires $true',
    '    Write-Output "Administrator password set successfully"',
    '} catch {',
    '    Write-Output "Error setting Administrator password: $_"',
    '}',
    
    '# Enable RDP',
    'Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name "fDenyTSConnections" -Value 0',
    'Enable-NetFirewallRule -DisplayGroup "Remote Desktop"',
    'Add-LocalGroupMember -Group "Remote Desktop Users" -Member "Administrator" -ErrorAction SilentlyContinue',
    'Write-Output "RDP enabled"',
    
    '# Create installation directory',
    'New-Item -Path "C:\\Installs" -ItemType Directory -Force',
    
    '# Create a file with credentials info',
    'New-Item -Path "C:\\AdminInfo" -ItemType Directory -Force',
    'Set-Content -Path "C:\\AdminInfo\\admin-credentials.txt" -Value "Administrator password: AdminPass123!"',
    
    '# Enable TLS 1.2 for downloads',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    
    '# Install NVIDIA Driver',
    'try {',
    '    Write-Output "Installing NVIDIA Driver..."',
    '    Invoke-WebRequest -Uri "https://nvidia-gaming.s3.amazonaws.com/windows/552.13_Cloud_Gaming_win10_win11_server2022_dch_64bit_international.exe" -OutFile "C:\\Installs\\NVIDIA_DRIVER_INSTALLER.exe"',
    '    Start-Process -FilePath "C:\\Installs\\NVIDIA_DRIVER_INSTALLER.exe" -ArgumentList "/s" -Wait',
    '    Write-Output "NVIDIA Driver installed successfully"',
    '    ',
    '    # Enable GPU for RDP',
    '    New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services" -Force -ErrorAction SilentlyContinue | Out-Null',
    '    Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services" -Name "bEnumerateHWBeforeSW" -Value 1 -Type DWord -Force',
    '    Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services" -Name "AVC444ModePreferred" -Value 1 -Type DWord -Force',
    '    Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services" -Name "AVCHardwareEncoding" -Value 1 -Type DWord -Force',
    '    Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services" -Name "bEnableHwAcceleration" -Value 1 -Type DWord -Force',
    '    Write-Output "GPU acceleration for RDP enabled"',
    '} catch {',
    '    Write-Output "Error installing NVIDIA Driver: $_"',
    '}',
    
    '# Verify driver installation',
    'try {',
    '    $videoController = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -like "*NVIDIA*" }',
    '    if ($videoController) {',
    '        Write-Output "NVIDIA driver installed successfully:"',
    '        Write-Output "Name: $($videoController.Name)"',
    '        Write-Output "Driver Version: $($videoController.DriverVersion)"',
    '        Write-Output "Video Mode: $($videoController.VideoModeDescription)"',
    '    } else {',
    '        Write-Output "NVIDIA driver not detected after installation."',
    '    }',
    '} catch {',
    '    Write-Output "Error checking driver status: $_"',
    '}',
    
    '# Create a password maintenance script to ensure password remains consistent',
    '$passwordScript = @"',
    'Start-Transcript -Path "C:\\SetupLogs\\password-maintenance.log" -Append',
    'Write-Output "Running password maintenance script at $(Get-Date)"',
    '',
    '# Reset Administrator password to ensure it remains consistent',
    '$Password = "AdminPass123!"',
    '$SecurePassword = ConvertTo-SecureString $Password -AsPlainText -Force',
    'Set-LocalUser -Name Administrator -Password $SecurePassword -PasswordNeverExpires $true',
    'Write-Output "Administrator password reset"',
    '',
    '# Ensure RDP is enabled',
    'Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name "fDenyTSConnections" -Value 0',
    'Enable-NetFirewallRule -DisplayGroup "Remote Desktop"',
    'Write-Output "RDP enabled"',
    '',
    'Write-Output "Password maintenance script completed at $(Get-Date)"',
    'Stop-Transcript',
    '"@',
    
    '# Save the password maintenance script',
    'Set-Content -Path "C:\\AdminInfo\\password-maintenance.ps1" -Value $passwordScript',
    
    '# Create a scheduled task for password maintenance',
    '$action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-ExecutionPolicy Bypass -File C:\\AdminInfo\\password-maintenance.ps1"',
    '$trigger = New-ScheduledTaskTrigger -Daily -At "3:00 AM"',
    '$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest',
    'Register-ScheduledTask -TaskName "PasswordMaintenance" -Action $action -Trigger $trigger -Principal $principal',
    'Write-Output "Created password maintenance task"',
    
    '# Create a log file to confirm everything completed',
    'Set-Content -Path "C:\\AdminInfo\\setup-complete.txt" -Value "Setup completed at $(Get-Date)"',
    'Write-Output "UserData script execution completed at $(Get-Date)"',
    'Stop-Transcript',
    
    '# Reboot to complete installations',
    'shutdown -r -t 10',
    '</powershell>',
    
    // Disable EC2Launch's automatic password generation
    '<runAsLocalSystem>true</runAsLocalSystem>'
  );

  // Create the instance with G4dn.xlarge and Windows Server 2022
  const instance = new ec2.Instance(scope, 'Instance', {
    vpc,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.G4DN, ec2.InstanceSize.XLARGE),
    machineImage: ec2.MachineImage.latestWindows(cdk.aws_ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE),
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroup: sg,
    role: instanceRole,
    userData,
    blockDevices: [
      {
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      },
    ],
  });
  instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  
  // Output the credentials information
  new cdk.CfnOutput(scope, 'AdminCredentials', {
    value: 'Username: Administrator, Password: AdminPass123!',
    description: 'Administrator credentials',
  });
  
  new cdk.CfnOutput(scope, 'InstallationLogPath', {
    value: 'C:\\SetupLogs\\software-installation.log',
    description: 'Path to the installation log file',
  });

  // Output the RDP connection command
  new cdk.CfnOutput(scope, 'RDPConnectionCommand', {
    value: `aws ssm start-session --target ${instance.instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3389"],"localPortNumber":["13389"]}'`,
    description: 'Command to start port forwarding for RDP connection',
  });

  // Output the RDP connection instruction
  new cdk.CfnOutput(scope, 'RDPConnectionInstruction', {
    value: `After running the above command, connect to localhost:13389 via RDP client using localhost:13389 with the username "Administrator" and password "AdminPass123!"`,
    description: 'Instruction for RDP connection',
  });
  
  return instance;
}
