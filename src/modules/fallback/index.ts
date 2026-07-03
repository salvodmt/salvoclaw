/**
 * Fallback module barrel — registers the `fallback_report` / `provider_error`
 * delivery actions and wires the global provider override to live DB state.
 * Import for side effects only (see src/modules/index.ts).
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerGlobalProviderOverride } from '../../provider-override.js';
import { getFallbackState } from './db.js';
import { handleFallbackReport, handleProviderError } from './controller.js';
import { effectiveProvider } from './override.js';
import './cli.js';

registerDeliveryAction('fallback_report', handleFallbackReport);
registerDeliveryAction('provider_error', handleProviderError);

registerGlobalProviderOverride((native) => effectiveProvider(native, getFallbackState()));
