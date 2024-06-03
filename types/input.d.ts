// types/input.d.ts
declare module "input" {
    export function text(prompt: string): Promise<string>
    export function password(prompt: string): Promise<string>
}
