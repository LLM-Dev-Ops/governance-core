/**
 * Placeholders for the two adapters that have no upstream service in the
 * deployed topology: schema registry (19) and config manager (18).
 *
 * They report failure rather than success so that any code path which starts
 * depending on them fails closed and becomes visible, instead of silently
 * treating "nothing validated it" as "it validated". The governance gate does
 * not invoke either adapter, so this does not weaken the gate.
 */

import type {
  AdapterResponse,
  ConfigValue,
  IConfigManagerAdapter,
  ISchemaRegistryAdapter,
  SchemaDefinition,
  ValidationResult,
} from './index';

function unconfigured<T>(adapter: string, method: string): AdapterResponse<T> {
  return {
    success: false,
    error: `${adapter}.${method} is unavailable: no upstream ${adapter} service is configured`,
  };
}

export class UnconfiguredSchemaRegistryAdapter implements ISchemaRegistryAdapter {
  async getSchema(): Promise<AdapterResponse<SchemaDefinition>> {
    return unconfigured('schemaRegistry', 'getSchema');
  }

  async validate(): Promise<AdapterResponse<ValidationResult>> {
    return unconfigured('schemaRegistry', 'validate');
  }

  async registerSchema(): Promise<AdapterResponse<{ schemaId: string; version: string }>> {
    return unconfigured('schemaRegistry', 'registerSchema');
  }
}

export class UnconfiguredConfigManagerAdapter implements IConfigManagerAdapter {
  async getConfig(): Promise<AdapterResponse<ConfigValue>> {
    return unconfigured('configManager', 'getConfig');
  }

  async getSecret(): Promise<AdapterResponse<string>> {
    return unconfigured('configManager', 'getSecret');
  }

  async watchConfig(): Promise<AdapterResponse<{ watchId: string }>> {
    return unconfigured('configManager', 'watchConfig');
  }

  async unwatchConfig(): Promise<AdapterResponse<void>> {
    return unconfigured('configManager', 'unwatchConfig');
  }
}
