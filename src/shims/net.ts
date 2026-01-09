const thrower = () => {
    throw new Error("Node 'net' is not available in the browser build.")
}

const netProxy = new Proxy(
    {},
    {
        get() {
            return thrower
        },
    },
)

export default netProxy
