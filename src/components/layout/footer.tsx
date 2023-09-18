import { Box, Group, Stack, createStyles } from "@mantine/core";
import Link from "next/link";
import { cmlDiscordInviteUrl } from "~/consts/cmlDiscordInviteUrl";




const useStyles = createStyles(() => ({
    outerFooter: {
        backgroundColor: "rgba(1.0, 1.0, 1.0, 0.9)",
        padding: "10px",
    },
    footer: {
        padding: "0 12px",
    },
    horizontalRule: {
        border: "2px solid #5b8bb3",
    },
    discordLink: {
        fontWeight: "bold",
        textAlign: "center",
    },
}));




export const Footer = () => {
    const { classes } = useStyles();


    return (
        <Box className={classes.outerFooter}>
            <hr className={classes.horizontalRule} />
            <footer className={classes.footer}>
                <Group
                    align="center"
                    grow
                    position="apart"
                >
                    <Stack
                        align="start"
                        spacing="1px"
                    >
                        <Link href="">My account</Link>
                        <Link href="">Settings</Link>
                    </Stack>
                    <Link
                        href={cmlDiscordInviteUrl}
                        className={classes.discordLink}
                    >
                        Join Our Discord Server!
                    </Link>
                    <Stack
                        align="end"
                        spacing="1px"
                    >
                        <Link href="">Cookie policy</Link>
                        <Link href="">Privacy policy</Link>
                    </Stack>
                </Group>
            </footer>
        </Box>
    );
};