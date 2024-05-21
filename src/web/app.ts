import * as FileProcessing from "./fileProcessing";

async function printFileName() {
    const [fileHandle] = await (window as any).showOpenFilePicker(); // Types are broken for this.
    const file = await fileHandle.getFile();
    console.log(file);
    await FileProcessing.prepFile(file);
}

const fileSelect = document.getElementById("fileSelect") as HTMLInputElement;

fileSelect.addEventListener("click", printFileName);



/*
const fileInput = document.getElementById("file") as HTMLInputElement;

fileInput.addEventListener("change", async (event) => {
    const target = event.target as HTMLInputElement
    if (target.files && target.files.length > 0) {
        const file = target.files[0]
        const fileName = file.name
        console.log("Selected file:", file)
        const compressedData = await compression.compressFileWithGzip(file)
        console.log(compressedData)
        const decompressedData = await compression.decompressFileWithGzip(compressedData)
        const decompressedFile = new File([decompressedData], fileName, { type: file.type })
        console.log(decompressedFile)
    }
})
*/