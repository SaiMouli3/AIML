/**
 * Importing this module registers every job handler and approval subject. Both the web server and the
 * worker import it so enqueued work and approval hooks resolve identically in either process.
 */
import "./agents/orchestrator";
import "./services/knowledge";
import "./services/content";
import "./services/media";
import "./services/integrations";
import "./services/promotions";
import "./services/ads";
import "./services/inbox";
import "./services/automations";
import "./services/analytics";
