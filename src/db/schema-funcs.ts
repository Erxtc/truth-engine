import { text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm';

export function forceEnum<const T extends readonly [string, ...string[]]>(
	name: string,
	values: T
) {
	return text(name, { enum: values }).$type<T[number]>();
}

export const dateTracking = {
	createdAt: text('createdAt').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
	updatedAt: text('updatedAt').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
}