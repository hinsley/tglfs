const thrower = () => {
    throw new Error("Node 'vm' is not available in the browser build.")
}

const vmProxy = new Proxy(
    {},
    {
        get() {
            return thrower
        },
    },
)

export default vmProxy
