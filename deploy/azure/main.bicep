// Power BI Metrics Book on Azure Container Apps. Copy this file,
// main.parameters.json and postgres-roots.pem into the deployment directory
// that pbmb init wrote: the database job reads postgres/init/ from there. The
// guide is apps/docs/src/content/docs/deploy/azure.md.
//
// Shape: a Container Apps environment in its own subnet, logging to Log
// Analytics; the api (external ingress), the worker (no ingress) and Cerbos
// (internal ingress); PostgreSQL Flexible Server reachable only from the
// virtual network; every bootstrap value a Key Vault reference. Each of the
// api, the worker and the database job has its own managed identity, allowed
// to read only the secrets it names. Pages relied on, read 26 October 2026:
// https://learn.microsoft.com/azure/templates/microsoft.app/containerapps
// https://learn.microsoft.com/azure/container-apps/custom-virtual-networks
// https://learn.microsoft.com/azure/container-apps/storage-mounts
// https://learn.microsoft.com/azure/container-apps/managed-identity-image-pull
// https://learn.microsoft.com/azure/key-vault/general/rbac-guide
// https://learn.microsoft.com/azure/storage/common/storage-network-security-virtual-networks
// https://learn.microsoft.com/azure/postgresql/extensions/how-to-allow-extensions
// https://learn.microsoft.com/azure/postgresql/security/security-tls
//
// Outbound traffic stays open, on purpose. The api and the worker call Entra
// ID, Microsoft Graph, the Power BI API and an embedding provider (OpenAI or
// Gemini), and pull the release image from ghcr.io. Network security groups
// filter by address and service tag; Graph, the embedding providers and
// ghcr.io have no service tag, so a group would have to allow port 443 to
// the whole internet and would close nothing
// (https://learn.microsoft.com/azure/container-apps/firewall-integration).
// Closing it takes Azure Firewall with host name rules and a route table on
// the apps subnet
// (https://learn.microsoft.com/azure/container-apps/user-defined-routes).

@description('A short prefix for every resource name: lower case letters and digits.')
param name string = 'pbmb'
param location string = resourceGroup().location

@description('The release image with its digest, as compose.yml names it: ghcr.io/enum-studio/powerbi-metrics-book:<version>@sha256:<digest>.')
param image string

@description('The pinned Postgres image of compose.yml, for the database job.')
param postgresImage string = 'pgvector/pgvector:pg18-trixie@sha256:5895949dfcdf308eb0cd31c950c93c14895c77f33fbedfecf1fa511ab1d4bcd2'

@description('Empty on the first deployment, which then makes everything but the three apps. Then the digest az acr build gave the Cerbos image: sha256:<digest>.')
param cerbosDigest string = ''

@description('The https address people open, the PUBLIC_BASE_URL in .env.')
param publicBaseUrl string

@description('The Key Vault that load-secrets.sh filled, in this resource group.')
param keyVaultName string

@description('Globally unique; the server is <name>.postgres.database.azure.com.')
param postgresServerName string
param postgresAdminLogin string = 'pbmbadmin'
@secure()
param postgresAdminPassword string

@description('After the custom domain is bound: the managed certificate for the host of publicBaseUrl, so a new deployment keeps the binding.')
param certificateId string = ''

@description('true: each identity comes from Key Vault as API_AGE_IDENTITY or WORKER_AGE_IDENTITY. false: each lives in its own Azure Files share.')
param identitiesFromKeyVault bool = false

param addressSpace string = '10.40.0.0/16'
@description('The Container Apps environment, and the default TRUSTED_PROXY: the ingress runs inside it.')
param appsSubnet string = '10.40.0.0/23'
param databaseSubnet string = '10.40.2.0/24'
@description('The api trusts X-Forwarded-For from here. Empty if the guide\'s check shows the ingress connects from elsewhere.')
param trustedProxy string = appsSubnet

var deployApps = !empty(cerbosDigest)
var cerbosApp = '${name}-cerbos'
var identityShares = identitiesFromKeyVault ? [] : ['api-identity', 'worker-identity']
var identityMountOptions = 'uid=10001,gid=10001,dir_mode=0700,file_mode=0600'
var secretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

// The Key Vault secrets each identity may read; load-secrets.sh makes them.
var readers = {
  api: concat(['api-database-url', 'migrator-database-url', 'audit-database-url', 'auth-secret'],
    identitiesFromKeyVault ? ['api-age-identity'] : [])
  worker: concat(['worker-database-url', 'audit-database-url'],
    identitiesFromKeyVault ? ['worker-age-identity'] : [])
  'database-init': ['postgres-password', 'migrator-password', 'api-rw-password', 'worker-rw-password', 'audit-writer-password']
}
var grants = flatten(map(items(readers), reader => map(reader.value, secret => { reader: reader.key, secret: secret })))

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [for reader in ['api', 'worker', 'database-init', 'cerbos']: {
  name: '${name}-${reader}'
  location: location
}]

var identityIds = {
  api: identities[0].id
  worker: identities[1].id
  'database-init': identities[2].id
  cerbos: identities[3].id
}
var principals = {
  api: identities[0].properties.principalId
  worker: identities[1].properties.principalId
  'database-init': identities[2].properties.principalId
}

resource grantedSecrets 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = [for grant in grants: {
  parent: vault
  name: grant.secret
}]

// Key Vault Secrets User on one secret at a time: an identity reads the
// values it names and no other.
resource readSecret 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (grant, index) in grants: {
  name: guid(grantedSecrets[index].id, identityIds[grant.reader], 'secrets-user')
  scope: grantedSecrets[index]
  properties: {
    roleDefinitionId: secretsUser
    principalId: principals[grant.reader]
    principalType: 'ServicePrincipal'
  }
}]

// Holds the Cerbos image az acr build makes: the pinned Cerbos image with the
// configuration and policies inside, running as uid 10001.
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: '${name}${uniqueString(resourceGroup().id)}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, anonymousPullEnabled: false }
}

resource pullCerbos 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identityIds.cerbos, 'acr-pull')
  scope: registry
  properties: {
    roleDefinitionId: acrPull
    principalId: identities[3].properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource network 'Microsoft.Network/virtualNetworks@2025-07-01' = {
  name: '${name}-network'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [addressSpace] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: appsSubnet
          delegations: [{ name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } }]
          // Lets the identity shares' firewall name this subnet.
          serviceEndpoints: [{ service: 'Microsoft.Storage' }]
        }
      }
      {
        name: 'database'
        properties: {
          addressPrefix: databaseSubnet
          delegations: [{ name: 'database', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

resource databaseZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${postgresServerName}.private.postgres.database.azure.com'
  location: 'global'
}

resource databaseZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: databaseZone
  name: network.name
  location: 'global'
  properties: {
    virtualNetwork: { id: network.id }
    registrationEnabled: false
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: postgresServerName
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '18'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    network: {
      delegatedSubnetResourceId: network.properties.subnets[1].id
      privateDnsZoneArmResourceId: databaseZone.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [databaseZoneLink]
}

// The init script creates both; an extension must be allowed here first.
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: database
  name: 'azure.extensions'
  properties: { value: 'VECTOR,PG_TRGM', source: 'user-override' }
}

// The identity shares only, reachable from the apps subnet and from Azure's
// trusted services: Azure Backup for Azure Files needs that exception
// (https://learn.microsoft.com/azure/backup/backup-azure-files). Shared key
// stays on: mounting a share with a managed identity is in preview
// (storage-mounts page), and the stable mount takes the account key.
resource identityFiles 'Microsoft.Storage/storageAccounts@2025-08-01' = if (!identitiesFromKeyVault) {
  name: take('${name}id${uniqueString(resourceGroup().id)}', 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [{ id: network.properties.subnets[0].id, action: 'Allow' }]
    }
  }
}

resource shares 'Microsoft.Storage/storageAccounts/fileServices/shares@2025-08-01' = [for share in identityShares: {
  name: '${identityFiles.name}/default/${share}'
  properties: { shareQuota: 1 }
}]

resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = {
  name: '${name}-environment'
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: network.properties.subnets[0].id, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

resource environmentShares 'Microsoft.App/managedEnvironments/storages@2026-07-01' = [for (share, index) in identityShares: {
  parent: environment
  name: share
  properties: {
    azureFile: {
      accountName: identityFiles.name
      accountKey: identityFiles!.listKeys().keys[0].value
      shareName: share
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [shares[index]]
}]

func secretsFrom(vaultUri string, identity string, names array) array => map(names, secretName => {
  name: secretName
  keyVaultUrl: '${vaultUri}secrets/${secretName}'
  identity: identity
})

var shared = [
  { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
  { name: 'CERBOS_URL', value: 'http://${cerbosApp}' }
  { name: 'AUDIT_DATABASE_URL', secretRef: 'audit-database-url' }
  { name: 'LOG_LEVEL', value: 'info' }
]

resource api 'Microsoft.App/containerApps@2026-07-01' = if (deployApps) {
  name: '${name}-api'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityIds.api}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        customDomains: empty(certificateId) ? [] : [
          { name: split(replace(publicBaseUrl, 'https://', ''), '/')[0], certificateId: certificateId, bindingType: 'SniEnabled' }
        ]
      }
      secrets: secretsFrom(vault.properties.vaultUri, identityIds.api, readers.api)
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          args: ['api']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(shared, [
            { name: 'DATABASE_URL', secretRef: 'api-database-url' }
            { name: 'MIGRATOR_DATABASE_URL', secretRef: 'migrator-database-url' }
            { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
            { name: 'TRUSTED_PROXY', value: trustedProxy }
          ], identitiesFromKeyVault ? [{ name: 'API_AGE_IDENTITY', secretRef: 'api-age-identity' }] : [])
          probes: [
            { type: 'Startup', httpGet: { path: '/health', port: 3000 }, periodSeconds: 5, failureThreshold: 24 }
            { type: 'Liveness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 10 }
          ]
          volumeMounts: identitiesFromKeyVault ? [] : [{ volumeName: 'identity', mountPath: '/var/lib/pbmb/identity' }]
        }
      ]
      volumes: identitiesFromKeyVault ? [] : [
        { name: 'identity', storageType: 'AzureFile', storageName: 'api-identity', mountOptions: identityMountOptions }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
  dependsOn: [readSecret, environmentShares, cerbos]
}

resource worker 'Microsoft.App/containerApps@2026-07-01' = if (deployApps) {
  name: '${name}-worker'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityIds.worker}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      // No ingress: nothing calls the worker.
      secrets: secretsFrom(vault.properties.vaultUri, identityIds.worker, readers.worker)
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          args: ['worker']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(shared, [
            { name: 'DATABASE_URL', secretRef: 'worker-database-url' }
          ], identitiesFromKeyVault ? [{ name: 'WORKER_AGE_IDENTITY', secretRef: 'worker-age-identity' }] : [])
          volumeMounts: identitiesFromKeyVault ? [] : [{ volumeName: 'identity', mountPath: '/var/lib/pbmb/identity' }]
        }
      ]
      volumes: identitiesFromKeyVault ? [] : [
        { name: 'identity', storageType: 'AzureFile', storageName: 'worker-identity', mountOptions: identityMountOptions }
      ]
      // One worker: each worker runs the schedule.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [readSecret, environmentShares, api]
}

resource cerbos 'Microsoft.App/containerApps@2026-07-01' = if (deployApps) {
  name: cerbosApp
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityIds.cerbos}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      // Internal: reachable from the environment's apps only, as http://<name>.
      ingress: { external: false, targetPort: 3592, transport: 'http', allowInsecure: true }
      registries: [{ server: registry.properties.loginServer, identity: identityIds.cerbos }]
    }
    template: {
      containers: [
        {
          name: 'cerbos'
          image: '${registry.properties.loginServer}/pbmb-cerbos@${cerbosDigest}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [{ type: 'Liveness', httpGet: { path: '/_cerbos/health', port: 3592 }, periodSeconds: 10 }]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [pullCerbos]
}

// Creates the roles, the database and its extensions once, from the
// deployment's own init script: az containerapp job start (the guide). The
// image has no CA bundle, so the job writes Azure's two roots to a file and
// checks the server's certificate and name against them.
resource databaseInit 'Microsoft.App/jobs@2026-07-01' = {
  name: '${name}-database-init'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityIds['database-init']}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: secretsFrom(vault.properties.vaultUri, identityIds['database-init'], readers['database-init'])
    }
    template: {
      containers: [
        {
          name: 'database-init'
          image: postgresImage
          command: ['bash', '-c', 'printf "%s" "$POSTGRES_ROOTS" >/tmp/roots.pem && exec bash -c "$0"', loadTextContent('postgres/init/01_roles_and_database.sh')]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'PGHOST', value: '${postgresServerName}.postgres.database.azure.com' }
            { name: 'PGSSLMODE', value: 'verify-full' }
            { name: 'PGSSLROOTCERT', value: '/tmp/roots.pem' }
            { name: 'POSTGRES_ROOTS', value: loadTextContent('postgres-roots.pem') }
            { name: 'PGPASSWORD', secretRef: 'postgres-password' }
            { name: 'POSTGRES_USER', value: postgresAdminLogin }
            { name: 'POSTGRES_DB', value: 'postgres' }
            // The admin is not a superuser. This lets it own what it creates
            // long enough to make migrator the database's owner.
            { name: 'PGOPTIONS', value: '-c createrole_self_grant=set,inherit' }
            { name: 'MIGRATOR_PASSWORD', secretRef: 'migrator-password' }
            { name: 'API_RW_PASSWORD', secretRef: 'api-rw-password' }
            { name: 'WORKER_RW_PASSWORD', secretRef: 'worker-rw-password' }
            { name: 'AUDIT_WRITER_PASSWORD', secretRef: 'audit-writer-password' }
          ]
        }
      ]
    }
  }
  dependsOn: [readSecret, extensions]
}

output registry string = registry.name
output apiAddress string = deployApps ? 'https://${api!.properties.configuration.ingress.fqdn}' : ''
