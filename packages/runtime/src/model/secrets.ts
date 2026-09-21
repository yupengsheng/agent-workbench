export interface SecretResolver {
  resolve(reference: string): Promise<string | undefined>;
}

export function createEnvironmentSecretResolver(
  environment: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  return {
    async resolve(reference: string) {
      if (reference === 'none') return undefined;
      const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(reference);
      if (!match) return undefined;
      const key = match[1];
      if (!key) return undefined;
      const value = environment[key];
      return value?.trim() || undefined;
    },
  };
}
