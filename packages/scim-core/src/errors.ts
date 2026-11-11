const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

/** A SCIM protocol error (RFC 7644 §3.12). */
export class ScimError extends Error {
	readonly status: number;
	readonly scimType?: string;

	constructor(status: number, scimType?: string, detail = "") {
		super(detail || scimType || String(status));
		this.name = "ScimError";
		this.status = status;
		this.scimType = scimType;
	}

	body() {
		return {
			schemas: [ERROR],
			status: String(this.status),
			...(this.scimType ? { scimType: this.scimType } : {}),
			detail: this.message,
		};
	}
}

/** Thrown by an adapter when a write would duplicate a unique value. Answers 409. */
export class ScimConflictError extends ScimError {
	constructor(detail = "Already exists") {
		super(409, "uniqueness", detail);
		this.name = "ScimConflictError";
	}
}

export const notFound = () => new ScimError(404, undefined, "Resource not found");
