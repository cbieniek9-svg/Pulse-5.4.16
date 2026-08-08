import PortalAuth from '../components/shared/PortalAuth.jsx';
import MarkdownApp from '../markdown/MarkdownApp.jsx';
import '../styles/markdown.css';

export default function MarkdownPage() {
    return (
        <PortalAuth
            title="FIFO EXPIRY TABLET"
            buttonLabel="ENTER"
            backLabel="← Back to TGP Center Store"
        >
            <MarkdownApp />
        </PortalAuth>
    );
}
