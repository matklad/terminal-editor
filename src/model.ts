export class Terminal {
    status(): { text: string } {
        return { text: "= =" };
    }

    output(): { text: string } {
        return { text: "hello world" };
    }
}