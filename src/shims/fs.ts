const thrower = () => {
    throw new Error("Node 'fs' is not available in the browser build.")
}

const promisesProxy = new Proxy(
    {},
    {
        get() {
            return thrower
        },
    },
)

const fsProxy = new Proxy(
    { promises: promisesProxy },
    {
        get(target, prop) {
            if (prop in target) {
                return target[prop as keyof typeof target]
            }
            return thrower
        },
    },
)

export const promises = promisesProxy
export default fsProxy
