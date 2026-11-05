export { createScimAdapter, type ScimAdapter, type ScimStore } from "./adapter.js";
export { ScimConflictError, ScimError } from "./errors.js";
export type { ScimChange, ScimHooks } from "./operations.js";
export type {
	ScimGroup,
	ScimGroupChange,
	ScimGroupFields,
	ScimName,
	ScimPage,
	ScimUser,
	ScimUserFields,
} from "./types.js";
