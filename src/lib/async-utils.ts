
/**
 * Executes an array of items with a fixed concurrency limit.
 * 
 * @param poolLimit Maximum number of concurrent executions.
 * @param items Array of items to process.
 * @param iteratorFn Asynchronous function that processes each item.
 * @returns Array of results in the same order as items.
 */
export async function asyncPool<T>(
    poolLimit: number,
    items: any[],
    iteratorFn: (item: any) => Promise<T>
): Promise<T[]> {
    const ret: Promise<T>[] = []
    const executing: Promise<T>[] = []
    
    for (const item of items) {
        const p = Promise.resolve().then(() => iteratorFn(item))
        ret.push(p)
        
        const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1))
        executing.push(e)
        
        if (executing.length >= poolLimit) {
            await Promise.race(executing)
        }
    }
    
    return Promise.all(ret)
}

/**
 * Convenience helper to add a delay between starting concurrent tasks.
 */
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
